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

const sumOfSizes = async filter => {
    const [total] = await File.aggregate([{ $match: filter }, { $group: { _id: null, bytes: { $sum: '$size' } } }])
    return total?.bytes ?? 0
}

// What takes up room in storage: everything whose object exists or may exist — including
// one that is being deleted, until it really is gone.
const STORED = { state: { $in: ['pending', 'attached', 'removing'] } }

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
        const claimed = await File.updateOne({ _id: file._id, state: file.state }, { $set: { state: 'removing' } })
        if (claimed.modifiedCount !== 1 && file.state !== 'removing') return false
        await storage.remove(file.key)
        if (keepCharge) await File.updateOne({ _id: file._id }, { $set: { state: 'discarded' }, $unset: { placeholder: 1 } })
        else await File.deleteOne({ _id: file._id })
        return true
    }
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
            _id: randomUUID(), conversationId, uploader: user.userId, address, ...file,
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
     * Attaches uploads to the message at position `at`: each must be the sender's own,
     * uploaded for this conversation, not used yet — and really there, as large as it
     * was declared. Resolves to the attachments as the message carries them.
     */
    const claim = async ({ fileIds, sender, conversationId, at }) => {
        const found = await File.find({ _id: { $in: fileIds } }).lean()
        const byId = new Map(found.map(file => [file._id, file]))
        const files = fileIds.map(id => byId.get(id))
        if (files.some(file => !file || file.uploader !== sender.userId || file.state !== 'pending' || file.conversationId !== conversationId)) {
            refuse(NOT_AVAILABLE)
        }
        const stored = await Promise.all(files.map(file => storage.head(file.key)))
        if (stored.some((object, index) => object === null || object.size !== files[index].size)) refuse(NOT_UPLOADED)

        const ttlHours = settings.messageTtlHours
        const taken = await File.updateMany(
            { _id: { $in: fileIds }, state: 'pending', uploader: sender.userId },
            {
                $set: {
                    state: 'attached', messageId: at.id, attachedAt: at,
                    // A file lasts as long as the message it is in.
                    ...(ttlHours > 0 ? { expiresAt: new Date(at.ts + ttlHours * HOUR) } : {}),
                },
            },
        )
        // (Swept, or sent with another message, in the moment since they were looked at.)
        if (taken.modifiedCount !== fileIds.length) {
            await release(at.id)
            refuse(NOT_AVAILABLE)
        }
        return files.map(attachmentView)
    }

    /** Undoes `claim` for a message that was not saved after all. */
    const release = messageId => File.updateMany(
        { messageId, state: 'attached' },
        { $set: { state: 'pending' }, $unset: { messageId: 1, attachedAt: 1, expiresAt: 1 } },
    )

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
    const downloadUrl = async ({ fileId, userId, baseUrl }) => {
        const file = await File.findOne({ _id: fileId, state: 'attached' }).lean()
        if (!file) refuse(UNKNOWN_FILE)
        const member = memberOf(await Conversation.findById(file.conversationId).lean(), userId)
        if (!member || !joinedBefore(member, file.attachedAt)) refuse(UNKNOWN_FILE)
        const url = await storage.presignDownload({
            key: file.key, name: file.name, type: file.type, inline: isInlineType(file.type), baseUrl,
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
     * sent. If nothing was uploaded the reservation is undone, and costs nothing. If
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
                    const gone = await File.deleteOne({ _id: file._id, state: 'pending' })
                    result.refunded += gone.deletedCount
                } else if (await destroy(file, { keepCharge: true })) {
                    result.discarded += 1
                }
            } catch (error) {
                console.error("failed to sweep a pending upload:", error?.name)
            }
        }
        return result
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
        enabled, limits, reserve, claim, release, discardOfMessage, conversationDeleted, downloadUrl, usage,
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
        return attachments.downloadUrl({ fileId: payload.fileId, userId: user.userId, baseUrl: baseUrlOf(socket) })
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
        on('getFileUrl', 'getFileUrl', getFileUrl)
        on('getStorageUsage', 'usage', getStorageUsage)
    }

    return { registerOn }
}
