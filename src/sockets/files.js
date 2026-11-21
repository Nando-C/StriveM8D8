import { randomUUID } from 'node:crypto'
import { addressOfSocket } from '../clientAddress.js'
import { joinedBefore, memberOf } from '../conversations.js'
import { isDatabaseReady } from '../db.js'
import { Conversation } from '../models/conversation.js'
import { File } from '../models/file.js'
import { DOWNLOAD_URL_SECONDS, UPLOAD_URL_SECONDS, isInlineType } from '../storage/index.js'
import {
    MAX_CONVERSATION_ID_LENGTH, NOT_LOGGED_IN, Refusal, SLOW_DOWN, isNonEmptyString, isObject, refuse, withAck,
} from './validation.js'

// File attachments. The bytes never pass through this server: a client asks to upload
// (`requestUpload`), is given a short-lived address that accepts exactly that file, and
// sends it there itself; the file then travels as part of a message (`attachments` on
// `sendmessage`) and is fetched through another short-lived address (`getFileUrl`).
//
// What this file keeps is the bookkeeping: who uploaded what for which conversation, what
// it counts against, who may download it, and when its object must be deleted.

export const MAX_ATTACHMENTS_PER_MESSAGE = 10
export const MAX_PENDING_UPLOADS = 5

const MB = 1024 * 1024
const DAY = 24 * 60 * 60_000
const HOUR = 60 * 60_000
const MAX_NAME_LENGTH = 255
const MAX_TYPE_LENGTH = 100
const MAX_DIMENSION = 20_000
const MAX_PLACEHOLDER_LENGTH = 1000
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// A media type as a browser reports one: "type/subtype", nothing after it.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/
const PLACEHOLDER = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/

// Per socket. An upload costs a database write and a signature; a download, a signature.
const RATE_LIMITS = {
    requestUpload: { limit: 20, windowMs: 60_000 },
    getFileUrl: { limit: 60, windowMs: 10_000 },
    usage: { limit: 10, windowMs: 10_000 },
}

const OFF = 'File sharing is not available here'
const ACCOUNTS_ONLY = 'Create an account to send files'
const INVALID_FILE = 'Invalid file'
// One answer whatever is wrong with a file somebody names: not theirs, not there, not for them.
const UNKNOWN_FILE = 'Unknown file'
const NOT_AVAILABLE = 'An attachment is not available — upload it again'
const NOT_UPLOADED = 'An attachment was not uploaded completely'
const NOT_SAVED = 'Could not be saved'

export const isFileId = value => typeof value === 'string' && FILE_ID.test(value)

/** A file as it travels inside a message: what a client needs to show it, never where it is stored. */
const attachmentView = file => ({
    id: file._id,
    name: file.name,
    type: file.type,
    size: file.size,
    ...(file.width && file.height ? { width: file.width, height: file.height } : {}),
    ...(file.durationMs === undefined || file.durationMs === null ? {} : { durationMs: file.durationMs }),
    ...(file.placeholder ? { placeholder: file.placeholder } : {}),
})

/** (For `$unset`.) */
const NOT_COPYING = { copyKey: 1, copyingSince: 1 }

const sumOfSizes = async filter => {
    const [total] = await File.aggregate([{ $match: filter }, { $group: { _id: null, bytes: { $sum: '$size' } } }])
    return total?.bytes ?? 0
}

// How long after an upload was reserved its URL is taken to be dead for good. The URL
// itself lapses after half of that, but an upload begun just before may still be
// arriving: whatever is at the upload key after this long is deleted, unseen.
const UPLOAD_KEY_GONE_MS = 2 * UPLOAD_URL_SECONDS * 1000
// A copy noted this long ago and still not the file's own was left behind: by a crash, or a failure that could not be tidied.
const COPY_ABANDONED_MS = 5 * 60_000
// What takes up room in storage: everything whose object exists or may exist — including
// one that is being deleted, until it really is gone, and one that was given up before
// anything arrived, for as long as its upload URL might still be used.
const STORED = { state: { $in: ['pending', 'attached', 'removing', 'unused'] } }

/**
 * The bookkeeping of uploads, with no sockets in it. `storage` is null where file sharing
 * is not configured; everything then refuses or does nothing.
 */
export const createAttachments = ({ storage, settings }) => {
    const enabled = storage !== null
    const limits = {
        fileBytes: Math.floor(settings.uploadMaxFileMb * MB),
        userBytesPerDay: Math.floor(settings.uploadMaxUserMbPerDay * MB),
        addressBytesPerDay: Math.floor(settings.uploadMaxAddressMbPerDay * MB),
        totalBytes: Math.floor(settings.uploadMaxTotalMb * MB),
    }

    // Deletes a file's object and then lets go of the room it took: in that order, so the
    // total never counts less than is really stored. With `keepCharge` the record stays
    // (as `discarded`) so that it still counts against today's allowances.
    const destroy = async (file, { keepCharge }) => {
        // (As it was read: if it has been sent meanwhile, or sent and given back — which
        // moves it to another key — this is no longer the object to delete.)
        const claimed = await File.updateOne({ _id: file._id, state: file.state, key: file.key }, { $set: { state: 'removing' } })
        if (claimed.modifiedCount !== 1 && file.state !== 'removing') return false
        await storage.remove(file.key)
        // (With the record goes the memory of where its upload URL wrote.)
        if (!keepCharge && file.uploadKey && file.uploadKey !== file.key) await storage.remove(file.uploadKey)
        if (keepCharge) await File.updateOne({ _id: file._id }, { $set: { state: 'discarded' }, $unset: { placeholder: 1 } })
        else await File.deleteOne({ _id: file._id })
        return true
    }
    const removeQuietly = key =>
        storage.remove(key).catch(error => console.error("failed to delete a stored object:", error?.name))
    const destroyAll = async (files, options) => {
        for (const file of files) {
            await destroy(file, options).catch(error => console.error("failed to delete a stored file:", error?.name))
        }
    }

    /**
     * Reserves an upload. Charged at once, by its declared size, to the uploader's day,
     * to their address's day and to the total — so that asking is not free, whatever
     * happens next. Resolves to `{ fileId, uploadUrl, headers }`.
     */
    const reserve = async ({ user, address, conversationId, file, baseUrl }) => {
        const now = Date.now()
        const created = await File.create({
            _id: randomUUID(), conversationId, uploader: user.userId, address, ...file, uploadKey: file.key,
        })
        const reserved = created.toObject()
        const today = { createdAt: { $gt: new Date(now - DAY) } }
        // Counted with this one in it: of several asked for at the same moment, each is
        // counted with the others, and all of them may be turned down.
        const [pending, byUser, byAddress, stored] = await Promise.all([
            File.countDocuments({ uploader: user.userId, state: 'pending' }),
            sumOfSizes({ uploader: user.userId, ...today }),
            limits.addressBytesPerDay > 0 ? sumOfSizes({ address, ...today }) : 0,
            sumOfSizes(STORED),
        ])
        const refusal =
            pending > MAX_PENDING_UPLOADS ? `Send or remove what you have already attached first (at most ${MAX_PENDING_UPLOADS} at a time)`
            : byUser > limits.userBytesPerDay ? 'You have reached your upload limit for today'
            : byAddress > limits.addressBytesPerDay && limits.addressBytesPerDay > 0 ? 'Too much has been uploaded from this network today'
            : stored > limits.totalBytes ? 'Storage is full — no more files can be uploaded for now'
            : null
        if (refusal) {
            await File.deleteOne({ _id: reserved._id })
            refuse(refusal)
        }
        const { url, headers } = await storage.presignUpload({ key: reserved.key, type: reserved.type, size: reserved.size, baseUrl })
        return { fileId: reserved._id, uploadUrl: url, headers, expiresInSeconds: UPLOAD_URL_SECONDS }
    }

    /**
     * Attaches uploads to a message: each must be the sender's own, uploaded for this
     * conversation, not used yet — and really there, as large as it was declared.
     *
     * Each object is copied to a key of its own first, and it is the copy the message
     * carries: the upload URL, which stays usable for a while, writes somewhere the
     * message no longer looks. What was sent is what stays.
     *
     * `position()` gives the message its position, and is asked only once the slow part
     * (storage) is over — a message must not be dated before others that were delivered
     * while its files were being checked. Resolves to `{ attachments, at, done }`;
     * `done()` is to be called once the message is saved (or is not going to be): it
     * deletes the objects no longer needed, which takes time the message must not wait for.
     */
    const claim = async ({ fileIds, sender, conversationId, position }) => {
        const found = await File.find({ _id: { $in: fileIds } }).lean()
        const byId = new Map(found.map(file => [file._id, file]))
        const files = fileIds.map(id => byId.get(id))
        if (files.some(file => !file || file.uploader !== sender.userId || file.state !== 'pending' || file.conversationId !== conversationId)) {
            refuse(NOT_AVAILABLE)
        }
        const kept = files.map(() => `files/${randomUUID()}`)
        // Whether any record may point at a copy yet.
        let written = false
        // Whichever of the two objects each file ends up not using is deleted — however this ends.
        const tidy = async () => {
            try {
                // (Nothing was written: no record points at a copy, and there is nothing to ask.)
                const now = written ? await File.find({ _id: { $in: fileIds } }, { key: 1 }).lean() : []
                const inUse = new Set(now.map(file => file.key))
                await Promise.all(files.map((file, index) => removeQuietly(inUse.has(kept[index]) ? file.key : kept[index])))
                // Dealt with: there is nothing left for the sweep to find.
                await File.updateMany({ _id: { $in: fileIds }, copyKey: { $in: kept } }, { $unset: NOT_COPYING })
            } catch (error) {
                console.error("failed to tidy up after attaching files:", error?.name)
            }
        }
        try {
            // Where each copy is going is written down before it is made: a copy that
            // nothing ever came to use (the server stopped just then) is found by that.
            await File.bulkWrite(files.map((file, index) => ({
                updateOne: {
                    filter: { _id: file._id, state: 'pending', key: file.key },
                    update: { $set: { copyKey: kept[index], copyingSince: new Date() } },
                },
            })))
            // (Every copy is over, one way or the other, before anything is concluded — or
            // one still under way would arrive after its key had been tidied away.)
            const copied = await Promise.allSettled(files.map((file, index) => storage.copy(file.key, kept[index])))
            const failure = copied.find(copy => copy.status === 'rejected')
            if (failure) throw failure.reason
            if (copied.some(copy => copy.value === false)) refuse(NOT_UPLOADED)
            const stored = await Promise.all(kept.map(key => storage.head(key)))
            if (stored.some((object, index) => object === null || object.size !== files[index].size)) refuse(NOT_UPLOADED)

            const at = position()
            const ttlHours = settings.messageTtlHours
            written = true
            const taken = await File.bulkWrite(files.map((file, index) => ({
                updateOne: {
                    // (Still the copy noted above: not one the sweep has taken for abandoned, and deleted.)
                    filter: { _id: file._id, state: 'pending', uploader: sender.userId, key: file.key, copyKey: kept[index] },
                    update: {
                        $unset: NOT_COPYING,
                        $set: {
                            state: 'attached', key: kept[index], messageId: at.id, attachedAt: at,
                            // A file lasts as long as the message it is in.
                            ...(ttlHours > 0 ? { expiresAt: new Date(at.ts + ttlHours * HOUR) } : {}),
                        },
                    },
                },
            }))).catch(async error => {
                // (Some of them may have been attached before it failed.)
                await release(at.id).catch(() => {})
                throw error
            })
            // (Swept, or sent with another message, in the moment since they were looked at.)
            if (taken.modifiedCount !== fileIds.length) {
                await release(at.id)
                refuse(NOT_AVAILABLE)
            }
            return { attachments: files.map(attachmentView), at, done: tidy }
        } catch (error) {
            await tidy()
            throw error
        }
    }

    /** Undoes `claim` for a message that was not saved after all. */
    const release = messageId => File.updateMany(
        { messageId, state: 'attached' },
        { $set: { state: 'pending' }, $unset: { messageId: 1, attachedAt: 1, expiresAt: 1 } },
    )

    // Nothing was uploaded. The record stays as `unused` — still counted, against the day
    // and against storage — until its upload URL is certainly dead, because something may
    // yet arrive at it. Then, if nothing did, it is dropped and has cost nothing; if
    // something did, it is deleted and stays charged to the day like any upload not sent.
    // (Only as it was read: see `destroy`.)
    const giveUp = file => File.updateOne(
        { _id: file._id, state: 'pending', key: file.key }, { $set: { state: 'unused' }, $unset: { placeholder: 1 } },
    )

    /**
     * The uploader thinks better of a file before sending it. As with one that is never
     * sent: free if nothing was uploaded (after half an hour: see `giveUp`), and otherwise
     * deleted but still charged to the day.
     */
    const cancel = async ({ fileId, userId }) => {
        const file = await File.findOne({ _id: fileId, uploader: userId, state: 'pending' }).lean()
        if (!file) refuse(UNKNOWN_FILE)
        if (await storage.head(file.key) === null) await giveUp(file)
        else await destroy(file, { keepCharge: true })
    }

    /** The files of a message that is being deleted: gone from storage, still counted against today. */
    const discardOfMessage = async messageId =>
        destroyAll(await File.find({ messageId, state: 'attached' }).lean(), { keepCharge: true })

    /** A conversation was deleted with everything in it. */
    const conversationDeleted = async conversationId => {
        if (!enabled) return
        await destroyAll(await File.find({ conversationId, state: { $in: ['pending', 'attached'] } }).lean(), { keepCharge: true })
    }

    /**
     * A download address for `userId`, if they may have the file: they are in its
     * conversation and could read the message it is attached to — someone who joined a
     * group later cannot fetch what was sent before, any more than they can read it.
     */
    const downloadUrl = async ({ fileId, userId, baseUrl, download = false }) => {
        const file = await File.findOne({ _id: fileId, state: 'attached' }).lean()
        if (!file) refuse(UNKNOWN_FILE)
        const member = memberOf(await Conversation.findById(file.conversationId).lean(), userId)
        if (!member || !joinedBefore(member, file.attachedAt)) refuse(UNKNOWN_FILE)
        const url = await storage.presignDownload({
            // `download`: to be saved rather than shown, whatever it is.
            key: file.key, name: file.name, type: file.type, inline: !download && isInlineType(file.type), baseUrl,
        })
        return { url, expiresInSeconds: DOWNLOAD_URL_SECONDS }
    }

    const usage = async () => ({
        usedBytes: await sumOfSizes(STORED),
        maxBytes: limits.totalBytes,
        files: await File.countDocuments({ state: 'attached' }),
    })

    /**
     * Every five minutes: uploads reserved more than fifteen minutes ago and still not
     * sent. If nothing was uploaded the reservation is undone, and costs nothing once
     * its URL is certainly dead (half an hour after it was made). If
     * something was, it is deleted — and stays charged to the day's allowances: neither
     * reserving without uploading nor uploading without sending gets around the limits.
     */
    const sweepPending = async ({ now = Date.now() } = {}) => {
        const result = { refunded: 0, discarded: 0 }
        if (!enabled || !isDatabaseReady()) return result
        const stale = await File.find({ state: 'pending', createdAt: { $lt: new Date(now - UPLOAD_URL_SECONDS * 1000) } }).limit(500).lean()
        for (const file of stale) {
            try {
                if (await storage.head(file.key) === null) {
                    // (Unless it was sent a moment ago after all.)
                    const gone = await giveUp(file)
                    result.refunded += gone.modifiedCount
                } else if (await destroy(file, { keepCharge: true })) {
                    result.discarded += 1
                }
            } catch (error) {
                console.error("failed to sweep a pending upload:", error?.name)
            }
        }
        await sweepUploadKeys(now)
        await sweepCopies(now)
        return result
    }

    // Upload URLs that can no longer be in use: whatever is at the key they wrote to is
    // deleted — an upload that arrived after it was given up, or after its message went
    // (the message has a copy of its own). Nothing that is still in use is ever there.
    const sweepUploadKeys = async now => {
        const old = await File.find({ uploadKey: { $exists: true }, createdAt: { $lt: new Date(now - UPLOAD_KEY_GONE_MS) } }).limit(500).lean()
        for (const file of old) {
            try {
                // (Still the object itself: an upload not yet sent, which the sweep above deals with.)
                if (file.uploadKey === file.key && (file.state === 'pending' || file.state === 'attached' || file.state === 'removing')) continue
                if (file.state === 'unused') {
                    // Given up — and then uploaded all the same? Deleted, and charged after all.
                    if (await storage.head(file.uploadKey) !== null) await destroy(file, { keepCharge: true })
                    else await File.deleteOne({ _id: file._id, state: 'unused' })
                    continue
                }
                await storage.remove(file.uploadKey)
                await File.updateOne({ _id: file._id }, { $unset: { uploadKey: 1 } })
            } catch (error) {
                console.error("failed to clear an upload key:", error?.name)
            }
        }
    }

    // Copies that were being made and never became anything.
    const sweepCopies = async now => {
        const left = await File.find({ copyKey: { $exists: true }, copyingSince: { $lt: new Date(now - COPY_ABANDONED_MS) } }).limit(500).lean()
        for (const file of left) {
            try {
                if (file.copyKey !== file.key) await storage.remove(file.copyKey)
                await File.updateOne({ _id: file._id, copyKey: file.copyKey }, { $unset: NOT_COPYING })
            } catch (error) {
                console.error("failed to clear an abandoned copy:", error?.name)
            }
        }
    }

    /**
     * Every hour: files whose message has expired are deleted, object and record; a
     * deletion that failed half-way is finished; and records kept only for a day's
     * allowance are dropped once the day is over.
     */
    const sweepExpired = async ({ now = Date.now() } = {}) => {
        const result = { expired: 0 }
        if (!enabled || !isDatabaseReady()) return result
        const expired = await File.find({ state: 'attached', expiresAt: { $lt: new Date(now) } }).limit(1000).lean()
        for (const file of expired) {
            if (await destroy(file, { keepCharge: false }).catch(() => false)) result.expired += 1
        }
        const unfinished = await File.find({ state: 'removing', createdAt: { $lt: new Date(now - HOUR) } }).limit(1000).lean()
        await destroyAll(unfinished, { keepCharge: true })
        await File.deleteMany({ state: 'discarded', createdAt: { $lt: new Date(now - DAY) } })
        return result
    }

    return {
        enabled, limits, reserve, cancel, claim, release, discardOfMessage, conversationDeleted, downloadUrl, usage,
        sweepPending, sweepExpired,
    }
}

// What a client says about the file it wants to upload, checked and tidied.
const fileIn = (payload, limits) => {
    const name = typeof payload.name === 'string'
        // A name is a label: no path, nothing unprintable.
        // eslint-disable-next-line no-control-regex
        ? payload.name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, MAX_NAME_LENGTH)
        : ''
    const type = typeof payload.type === 'string' ? payload.type.trim().toLowerCase() : ''
    if (name === '' || type.length > MAX_TYPE_LENGTH || !MEDIA_TYPE.test(type)) refuse(INVALID_FILE)
    if (!Number.isSafeInteger(payload.size) || payload.size < 1) refuse(INVALID_FILE)
    if (payload.size > limits.fileBytes) refuse(`A file can be at most ${Math.floor(limits.fileBytes / MB)} MB`)

    const whole = (value, max) => (Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined)
    const width = whole(payload.width, MAX_DIMENSION)
    const height = whole(payload.height, MAX_DIMENSION)
    const durationMs = Number.isSafeInteger(payload.durationMs) && payload.durationMs >= 0 && payload.durationMs <= DAY
        ? payload.durationMs : undefined
    const placeholder = typeof payload.placeholder === 'string' && payload.placeholder.length <= MAX_PLACEHOLDER_LENGTH &&
        PLACEHOLDER.test(payload.placeholder) ? payload.placeholder : undefined
    return {
        key: `files/${randomUUID()}`, name, type, size: payload.size,
        // (A shape is both numbers or neither.)
        ...(width && height ? { width, height } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(placeholder ? { placeholder } : {}),
    }
}

/** The socket events of file sharing. */
export const createFileHandlers = ({ presence, settings, rateLimiter, attachments, messages }) => {
    const allowed = rateLimiter.perSocket(RATE_LIMITS)

    // This server's own address, as the client reached it: where the local driver's URLs point.
    const baseUrlOf = socket => {
        const { headers, secure } = socket.handshake
        const forwarded = settings.trustedProxyHops > 0 ? String(headers['x-forwarded-proto'] ?? '').split(',')[0].trim() : ''
        return `${forwarded || (secure ? 'https' : 'http')}://${headers.host}`
    }

    const requestUpload = async ({ socket, user, payload }) => {
        // Guest names are free and without number: an allowance per guest would limit nothing.
        if (user.kind !== 'account') refuse(ACCOUNTS_ONLY)
        if (!isNonEmptyString(payload.conversationId, MAX_CONVERSATION_ID_LENGTH)) refuse(INVALID_FILE)
        const file = fileIn(payload, attachments.limits)
        const refusal = await messages.refusalToWrite(payload.conversationId, user)
        if (refusal) refuse(refusal)
        return attachments.reserve({
            user, file, conversationId: payload.conversationId,
            address: addressOfSocket(socket, settings.trustedProxyHops), baseUrl: baseUrlOf(socket),
        })
    }

    const getFileUrl = async ({ socket, user, payload }) => {
        if (!isFileId(payload.fileId)) refuse(UNKNOWN_FILE)
        return attachments.downloadUrl({
            fileId: payload.fileId, userId: user.userId, baseUrl: baseUrlOf(socket), download: payload.download === true,
        })
    }

    const cancelUpload = async ({ user, payload }) => {
        if (!isFileId(payload.fileId)) refuse(UNKNOWN_FILE)
        await attachments.cancel({ fileId: payload.fileId, userId: user.userId })
        return {}
    }

    // How full storage is: for whoever runs the deployment, who is the one to act on it.
    const getStorageUsage = async ({ user }) => {
        if (!user.admin) refuse('Only an administrator can see that')
        return attachments.usage()
    }

    const registerOn = socket => {
        const on = (event, limit, handler) => {
            socket.on(event, async (rawPayload, rawAck) => {
                const { payload, reply, fail } = withAck(rawPayload, rawAck)

                if (!allowed(socket, limit)) return fail(SLOW_DOWN)
                const user = presence.bySocket.get(socket.id)
                if (!user) return fail(NOT_LOGGED_IN)
                if (!attachments.enabled) return fail(OFF)
                if (!isDatabaseReady()) return fail(NOT_SAVED)
                try {
                    const result = await handler({ socket, user, payload: isObject(payload) ? payload : {} })
                    reply({ ok: true, ...result })
                } catch (error) {
                    if (error instanceof Refusal) return fail(error.message)
                    console.error(`${event} failed:`, error?.name)
                    fail(NOT_SAVED)
                }
            })
        }

        on('requestUpload', 'requestUpload', requestUpload)
        on('cancelUpload', 'requestUpload', cancelUpload)
        on('getFileUrl', 'getFileUrl', getFileUrl)
        on('getStorageUsage', 'usage', getStorageUsage)
    }

    return { registerOn }
}
