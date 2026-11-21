import { BOT, BOT_MEMBER, BOT_REPLY_DELAY_MS, botReply, mentionsBot, withoutBotMention } from '../bot.js'
import {
    NOT_TO_READ, advancePosition, conversationViewFor, directConversationId, joinedBefore, lastPosition, memberOf, parseDirectId,
    previewOf, publishPositions, receiptOf, visibleTo,
} from '../conversations.js'
import mongoose from 'mongoose'
import { isDatabaseReady, isDuplicateKey } from '../db.js'
import { Conversation } from '../models/conversation.js'
import { Identity } from '../models/identity.js'
import { Message } from '../models/message.js'
import { afterPosition, beforePosition, comparePositions, isPosition, laterPosition, positionOf } from '../positions.js'
import {
    MAX_CONVERSATION_ID_LENGTH, NOT_LOGGED_IN, Refusal, SLOW_DOWN, UNKNOWN_CONVERSATION, isDocumentId, isNonEmptyString,
    isObject, withAck,
} from './validation.js'
import { MAX_ATTACHMENTS_PER_MESSAGE, isFileId } from './files.js'

// Messages and the conversations they belong to. A message is addressed to a
// conversation, never to a person or a connection: whoever is in the conversation's
// stored member list gets it, on every device they have connected, and finds it in
// history if they are not connected at all.

const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const MAX_TEXT_LENGTH = 2000
const HISTORY_PAGE = 100

// Per socket.
const RATE_LIMITS = {
    sendmessage: { limit: 10, windowMs: 10_000 },
    getHistory: { limit: 10, windowMs: 10_000 },
    markRead: { limit: 30, windowMs: 10_000 },
    deleteMessage: { limit: 10, windowMs: 10_000 },
}

const NOT_SAVED = 'Message could not be saved'
const NOT_LOADED = 'History could not be loaded'
const NO_LONGER_HERE = 'This person is no longer here'
// One answer for a message that does not exist, is somebody else's, or cannot be deleted.
const UNKNOWN_MESSAGE = 'Unknown message'

/** A stored message as `forUserId` receives it, live or in history: one shape for both. */
const messageView = (message, forUserId) => ({
    id: message._id.toString(),
    conversationId: message.conversationKey,
    from: message.from,
    fromName: message.fromName,
    kind: message.kind ?? 'text',
    text: message.text ?? null,
    ...(message.data === undefined ? {} : { data: message.data }),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    timestamp: message.createdAt.getTime(),
    // Only its author can make use of the id their own client gave a message.
    clientId: message.from === forUserId ? message.clientId ?? null : null,
})

export const createMessageHandlers = ({ io, presence, settings, rateLimiter, attachments }) => {
    const allowed = rateLimiter.perSocket(RATE_LIMITS)

    // Where a member stands is news only to whoever wrote what they have now received or
    // read: nobody else's screen shows anything of it. In a group of twenty, telling
    // everyone about everyone would be 380 events for a single message; this is 19.
    //
    // `since` is where the member stood, as far as others were told, before moving.
    const tellReceipt = async (conversation, userId, since) => {
        const member = memberOf(conversation, userId)
        const upTo = laterPosition(member?.published?.deliveredUpTo ?? null, member?.published?.readUpTo ?? null)
        if (upTo === null) return
        const others = conversation.members.filter(other => other.userId !== userId)
        // (Between two people there is nobody to leave out, and nothing to look up.)
        const authors = conversation.kind === 'direct'
            ? null
            : new Set(await Message.distinct('from', {
                conversationKey: conversation._id,
                kind: { $ne: 'system' },
                from: { $ne: userId },
                $and: [afterPosition(since), { $nor: [afterPosition(upTo)] }],
            }))
        for (const other of others) {
            if (authors !== null && !authors.has(other.userId)) continue
            const receipt = receiptOf(conversation, userId, other)
            if (receipt) presence.tell([other.userId], 'receipt', receipt)
        }
    }

    /**
     * Moves one member's delivered or read position forward and, if that changes what
     * others may know, tells those it concerns. Resolves to `{ moved, conversation }`:
     * whether the member's own (true) position moved, and the conversation as it then is
     * (null if they are not in it).
     */
    const advance = async (conversationId, userId, field, position) => {
        // While a user is invisible, what others are told about their reading stands still.
        const result = await advancePosition(conversationId, userId, field, position, { publish: presence.isShown(userId) })
        if ('publishedFrom' in result) await tellReceipt(result.conversation, userId, result.publishedFrom)
        return result
    }

    // A message goes to each device separately, with an acknowledgement of its own: that
    // is what says the message has reached *that person*. One emit to several sockets
    // would come back as a bundle of acknowledgements with nobody's name on them.
    const deliver = (saved, member, socketId) => {
        const socket = io.sockets.sockets.get(socketId)
        if (!socket) return
        socket.timeout(settings.deliveryAckTimeoutMs).emit('message', messageView(saved, member.userId), error => {
            // No acknowledgement in time: not delivered there, as far as anyone can say.
            if (error || !isDatabaseReady()) return
            advance(saved.conversationKey, member.userId, 'deliveredUpTo', positionOf(saved))
                .catch(failure => console.error("failed to record a delivery:", failure.name))
        })
    }

    /** Sends each connected member their own view of the conversation. */
    const tellMembers = async conversation => {
        // (A view costs an unread count: not worked out for somebody who is not there.)
        const connected = conversation.members.filter(member => presence.socketsOf(member.userId).length > 0)
        // The counts are asked for together, and the views sent in the members' order.
        const views = await Promise.allSettled(connected.map(member => conversationViewFor(conversation, member.userId)))
        // Counting took a moment, and someone may have gone in it (two people leaving a
        // group together): who is in the conversation is asked once more, and nothing
        // is awaited between that answer and the sending. Nobody is described a
        // conversation they have just been told they are out of.
        const now = await Conversation.findById(conversation._id, { 'members.userId': 1 }).lean()
        views.forEach((view, index) => {
            if (view.status === 'fulfilled' && memberOf(now, connected[index].userId)) {
                presence.tell([connected[index].userId], 'conversationUpdated', { conversation: view.value })
            }
        })
        const failed = views.find(view => view.status === 'rejected')
        if (failed) throw failed.reason
    }

    /**
     * Who a direct conversation that does not exist yet would be with, if `sender` may
     * begin it: the id must be exactly the pair of the sender and one other user who
     * exists. Anything else — a pair of two other people, a made-up id — gives null.
     */
    const directCounterpart = async (id, sender) => {
        const pair = parseDirectId(id)
        if (pair === null || !pair.includes(sender.userId)) return null
        // (A well-formed id never names the same user twice, so there is always another.)
        const otherId = pair.find(userId => userId !== sender.userId)
        return otherId === BOT.id
            ? (settings.demoBot ? BOT_MEMBER : null)
            : Identity.findOne({ userId: otherId }, { userId: 1, username: 1 }).lean()
    }

    /**
     * Why `sender` may not write in conversation `id`, or null if they may: they are in
     * it (and, between two people, the other still exists) — or it is a direct
     * conversation they could begin. Looked up; nothing is created.
     */
    const refusalToWrite = async (id, sender) => {
        const conversation = await Conversation.findById(id).lean()
        if (conversation) {
            // Who may write here is decided by the stored members and nothing else.
            if (!memberOf(conversation, sender.userId)) return UNKNOWN_CONVERSATION
            return conversation.kind === 'direct' && conversation.members.some(member => member.gone) ? NO_LONGER_HERE : null
        }
        return await directCounterpart(id, sender) ? null : UNKNOWN_CONVERSATION
    }

    /**
     * Finds the direct conversation `id` for `sender`, creating it if this is its first
     * message. Resolves to { conversation, created } or { refusal }.
     */
    const openDirect = async (id, sender) => {
        const other = await directCounterpart(id, sender)
        if (!other) return { refusal: UNKNOWN_CONVERSATION }

        try {
            const created = await Conversation.create({
                _id: directConversationId(sender.userId, other.userId),
                kind: 'direct',
                members: [
                    { userId: sender.userId, username: sender.username },
                    { userId: other.userId, username: other.username },
                ],
            })
            return { conversation: created.toObject(), created: true }
        } catch (error) {
            // Both of them sent their first message at the same moment.
            if (!isDuplicateKey(error)) throw error
            return { conversation: await Conversation.findById(id).lean(), created: false }
        }
    }

    /**
     * Saves a message and delivers it: to every connected device of every other member,
     * and to the author's other devices. `exceptSocketId` is the connection it came from,
     * which learns the outcome through its acknowledgement instead.
     *
     * `content` is `{ text, clientId, attachments }`, or `{ kind: 'system', data }` for
     * something that happened to the conversation itself; `at` gives a message the
     * position that was decided for it beforehand. `describe` also sends every member their view of the
     * conversation: 'after' the message (a direct chat's first), or 'before' it (a group
     * whose members or name just changed — so nobody is sent a message of a group they
     * have not been told they are in).
     */
    const post = async (conversation, author, content, { exceptSocketId = null, describe = null } = {}) => {
        const { text, clientId, kind = 'text', data, at = null, attachments: files = [] } = content
        const saved = await Message.create({
            ...(at === null ? {} : { _id: at.id, createdAt: new Date(at.ts) }),
            conversationKey: conversation._id,
            from: author.userId,
            fromName: author.username,
            kind,
            text,
            data,
            clientId,
            ...(files.length > 0 ? { attachments: files } : {}),
        })
        const position = positionOf(saved)

        // From here on the message exists. Nothing below may turn that into a reported
        // failure: the sender would send it again, and both copies would be in history.
        // If the bookkeeping fails it is logged, and corrects itself with the next message.
        let updated = null
        try {
            // The preview only ever moves forward, even if two saves finish out of order.
            updated = await Conversation.findOneAndUpdate(
                {
                    _id: conversation._id,
                    $or: [{ 'lastMessage.timestamp': { $lte: position.ts } }, { lastMessage: null }],
                },
                {
                    $set: {
                        lastMessage: {
                            id: position.id, from: author.userId, fromName: author.username,
                            preview: previewOf(text), timestamp: position.ts,
                            // What a client words the line under the name from, when there is no text.
                            ...(kind === 'text' ? {} : { kind, data }),
                            ...(files.length > 0 ? { attachments: files.length } : {}),
                        },
                        lastActivityAt: saved.createdAt,
                    },
                },
                { returnDocument: 'after' },
            ).lean()
            // Whoever wrote a message has read everything up to it. (Not so for a change
            // to a group: it can be made from the details panel without looking at a thing.)
            if (kind !== 'system') await advance(conversation._id, author.userId, 'readUpTo', position)
            // The bot has no device to acknowledge anything: what is said to it has reached it.
            if (settings.demoBot && author.userId !== BOT.id && memberOf(conversation, BOT.id) && conversation.kind === 'direct') {
                await advance(conversation._id, BOT.id, 'deliveredUpTo', position)
            }
        } catch (error) {
            console.error("failed to update a conversation after saving a message:", error.name)
        }

        // Who is in the conversation is read again each time it matters. `conversation` is
        // as the caller found it, several round trips ago: someone may have been taken out
        // since, and must be sent nothing more. (It also predates the author's own
        // position moving, which each member's view shows.)
        const asStored = async () => {
            try {
                return await Conversation.findById(conversation._id).lean()
            } catch (error) {
                console.error("failed to read a conversation again:", error.name)
                return updated ?? conversation
            }
        }
        const tellEveryone = async stored => {
            try {
                if (stored) await tellMembers(stored)
            } catch (error) {
                console.error("failed to describe a conversation:", error.name)
            }
        }
        // (For a change to a group nothing has been awaited since `updated` was read: it
        // is the conversation as stored.)
        if (describe === 'before') await tellEveryone(updated ?? await asStored())

        const current = await asStored()
        if (current === null) {
            // The conversation was deleted meanwhile (the last person left a group): its
            // messages went with it, and this one must not be left behind.
            await Message.deleteOne({ _id: saved._id })
                .catch(error => console.error("failed to remove a message of a deleted conversation:", error.name))
            // (Its files were attached after the conversation's own were deleted.)
            if (files.length > 0) {
                await attachments.discardOfMessage(saved._id.toString())
                    .catch(error => console.error("failed to remove the files of a deleted conversation:", error.name))
            }
            return saved
        }
        for (const member of current.members) {
            // Not for someone who joined with this very message, or after it: live or in
            // history, a member is shown only what came after they joined.
            if (!joinedBefore(member, position)) continue
            // The author's other devices are shown it; there is nothing to be delivered to its author.
            if (member.userId === author.userId) {
                presence.tell([member.userId], 'message', messageView(saved, member.userId), { exceptSocketId })
            } else {
                for (const socketId of presence.socketsOf(member.userId)) {
                    if (socketId !== exceptSocketId) deliver(saved, member, socketId)
                }
            }
        }
        // A conversation nobody has seen before is then described to each member in full
        // (who is in it, and their own unread count). It follows the message on purpose:
        // whatever a client worked out from the message alone, this replaces.
        // (Nothing has been awaited since `current` was read.)
        if (describe === 'after') await tellEveryone(current)
        return saved
    }

    // The bot answers a moment later, in the same conversation, like anyone else would.
    const answerAsBot = (conversation, asker, text) => {
        const turn = asker.botReplies
        asker.botReplies = turn + 1
        setTimeout(async () => {
            try {
                if (!isDatabaseReady()) return
                // As the conversation is by then: a group may have lost a member, or the bot, or be gone.
                const current = await Conversation.findById(conversation._id).lean()
                if (!memberOf(current, BOT.id)) return
                await post(current, BOT_MEMBER, { text: botReply(text, turn) })
            } catch (error) {
                console.error("demo bot failed to reply:", error.name)
            }
        }, BOT_REPLY_DELAY_MS).unref()
    }

    const registerOn = socket => {
        socket.on('sendmessage', async (rawPayload, rawAck) => {
            const { payload, reply, fail } = withAck(rawPayload, rawAck)

            if (!allowed(socket, 'sendmessage')) return fail(SLOW_DOWN)
            // Files that were uploaded beforehand, by id: at most ten, each named once.
            const fileIds = isObject(payload) && payload.attachments !== undefined ? payload.attachments : []
            if (
                !isObject(payload) ||
                !Array.isArray(fileIds) || fileIds.length > MAX_ATTACHMENTS_PER_MESSAGE ||
                !fileIds.every(isFileId) || new Set(fileIds).size !== fileIds.length ||
                typeof payload.text !== 'string' || payload.text.length > MAX_TEXT_LENGTH ||
                // A message must have something in it: words, or files.
                (payload.text.trim() === '' && fileIds.length === 0) ||
                !isNonEmptyString(payload.conversationId, MAX_CONVERSATION_ID_LENGTH) ||
                typeof payload.clientId !== 'string' ||
                !CLIENT_ID_PATTERN.test(payload.clientId)
            ) {
                return fail('Invalid message')
            }
            const { conversationId, clientId } = payload
            // (Files alone: no text at all, rather than the spaces that were typed.)
            const text = payload.text.trim() === '' ? '' : payload.text
            if (fileIds.length > 0 && !attachments.enabled) return fail('File sharing is not available here')

            // The sender's identity comes from the server's own state, never from the client.
            const sender = presence.bySocket.get(socket.id)
            if (!sender) return fail(NOT_LOGGED_IN)
            if (!isDatabaseReady()) return fail(NOT_SAVED)

            // With files, the message's position is decided before it is saved: it is what
            // each file is attached at — and what decides, later, who may download it.
            // (Decided by `claim`, as late as it can be.)
            const position = () => ({ ts: Date.now(), id: new mongoose.Types.ObjectId().toString() })
            let at = null
            let files = []
            let claimed = false
            // Clears away what attaching the files left in storage. After the message, never before.
            let done = async () => {}
            try {
                const refusal = await refusalToWrite(conversationId, sender)
                if (refusal) return fail(refusal)
                if (fileIds.length > 0) {
                    ;({ attachments: files, at, done } = await attachments.claim({ fileIds, sender, conversationId, position }))
                    claimed = true
                }

                let conversation = await Conversation.findById(conversationId).lean()
                let created = false
                if (!conversation) {
                    const opened = await openDirect(conversationId, sender)
                    if (opened.refusal) throw new Refusal(opened.refusal)
                    ;({ conversation, created } = opened)
                }
                // (Asked again of the conversation as it is now: the first answer is a moment old.)
                if (!memberOf(conversation, sender.userId)) throw new Refusal(UNKNOWN_CONVERSATION)
                if (conversation.kind === 'direct' && conversation.members.some(member => member.gone)) throw new Refusal(NO_LONGER_HERE)

                const saved = await post(
                    conversation, sender, { text, clientId, attachments: files, at },
                    { exceptSocketId: socket.id, describe: created ? 'after' : null },
                )
                claimed = false
                // The bot answers words, not files.
                if (memberOf(conversation, BOT.id) && settings.demoBot && text !== '') {
                    // In its own chats the bot answers everything; in a group, only what is addressed to it.
                    if (conversation.kind === 'direct') answerAsBot(conversation, sender, text)
                    else if (mentionsBot(text)) answerAsBot(conversation, sender, withoutBotMention(text))
                }
                reply({ ok: true, id: saved._id.toString(), timestamp: saved.createdAt.getTime() })
                // (After the answer: nobody waits for storage to be tidied.)
                await done()
            } catch (error) {
                // A message that was not saved has no files: they can be sent again.
                if (claimed) await attachments.release(at.id).catch(() => {})
                if (error instanceof Refusal) fail(error.message)
                else {
                    console.error("failed to save message:", error.name)
                    fail(NOT_SAVED)
                }
                await done()
            }
        })

        socket.on('getHistory', async payload => {
            const conversationId = isObject(payload) && typeof payload.conversationId === 'string'
                ? payload.conversationId
                : null
            const fail = message => socket.emit('historyError', { conversationId, message })

            if (!allowed(socket, 'getHistory')) return fail(SLOW_DOWN)
            if (conversationId === null || conversationId.length > MAX_CONVERSATION_ID_LENGTH) return fail('Invalid conversation')
            const before = payload.before ?? null
            if (before !== null && !isPosition(before)) return fail('Invalid position')

            const requester = presence.bySocket.get(socket.id)
            if (!requester) return fail(NOT_LOGGED_IN)
            if (!isDatabaseReady()) return fail(NOT_LOADED)

            try {
                const conversation = await Conversation.findById(conversationId).lean()
                const member = memberOf(conversation, requester.userId)
                if (!member) {
                    // A direct chat with someone that has no messages yet is simply empty —
                    // but only for an id that is the requester's own to open.
                    const pair = parseDirectId(conversationId)
                    const ownToOpen = !conversation && pair !== null && pair.includes(requester.userId)
                    if (!ownToOpen) return fail(UNKNOWN_CONVERSATION)
                    socket.emit('history', { conversationId, messages: [], hasMore: false })
                    return
                }

                const documents = await Message
                    .find({
                        conversationKey: conversationId,
                        $and: [visibleTo(member), before === null ? {} : beforePosition(before)],
                    })
                    .sort({ createdAt: -1, _id: -1 })
                    // One more than a page, to know whether there is anything earlier.
                    .limit(HISTORY_PAGE + 1)
                    .lean()

                const hasMore = documents.length > HISTORY_PAGE
                const messages = documents.slice(0, HISTORY_PAGE).reverse().map(document => messageView(document, requester.userId))
                socket.emit('history', { conversationId, messages, hasMore })
            } catch (error) {
                console.error("failed to load history:", error.name)
                fail(NOT_LOADED)
            }
        })

        // "I have read this conversation up to here." Stored, so that unread counts are
        // right at the next login, and told to whoever wrote what was read.
        socket.on('markRead', async (rawPayload, rawAck) => {
            const { payload, reply, fail } = withAck(rawPayload, rawAck)

            if (!allowed(socket, 'markRead')) return fail(SLOW_DOWN)
            if (
                !isObject(payload) ||
                !isNonEmptyString(payload.conversationId, MAX_CONVERSATION_ID_LENGTH) ||
                !isPosition(payload.upTo)
            ) {
                return fail('Invalid position')
            }
            const reader = presence.bySocket.get(socket.id)
            if (!reader) return fail(NOT_LOGGED_IN)
            if (!isDatabaseReady()) return fail('Could not be saved')

            try {
                const conversation = await Conversation.findById(payload.conversationId).lean()
                if (!memberOf(conversation, reader.userId)) return fail(UNKNOWN_CONVERSATION)

                // Nobody has read past the last message there is.
                const last = lastPosition(conversation.lastMessage)
                if (last === null) return reply({ ok: true })
                const upTo = comparePositions(payload.upTo, last) > 0 ? last : { ts: payload.upTo.ts, id: payload.upTo.id }

                const { moved } = await advance(conversation._id, reader.userId, 'readUpTo', upTo)
                if (moved) {
                    // The reader's other devices drop their unread badge too.
                    if (presence.socketsOf(reader.userId).some(id => id !== socket.id)) {
                        const fresh = await Conversation.findById(conversation._id).lean()
                        if (fresh) {
                            presence.tell(
                                [reader.userId], 'conversationUpdated',
                                { conversation: await conversationViewFor(fresh, reader.userId) },
                                { exceptSocketId: socket.id },
                            )
                        }
                    }
                }
                reply({ ok: true })
            } catch (error) {
                console.error("failed to save a read position:", error.name)
                fail('Could not be saved')
            }
        })

        // Taking back one's own message. What is left is a marker where it stood — its
        // words and files are gone, from the database and from storage — so that the
        // conversation still reads in order and nobody's positions point at nothing.
        socket.on('deleteMessage', async (rawPayload, rawAck) => {
            const { payload, reply, fail } = withAck(rawPayload, rawAck)

            if (!allowed(socket, 'deleteMessage')) return fail(SLOW_DOWN)
            if (!isObject(payload) || !isDocumentId(payload.id)) return fail(UNKNOWN_MESSAGE)
            const author = presence.bySocket.get(socket.id)
            if (!author) return fail(NOT_LOGGED_IN)
            if (!isDatabaseReady()) return fail('Could not be saved')

            try {
                // One's own, and something that was said: not a line about a group, not already deleted.
                // (A message from before messages had kinds has none stored, and was said.)
                const own = { _id: payload.id, from: author.userId, kind: { $nin: NOT_TO_READ } }
                const message = await Message.findOne(own).lean()
                // (Someone no longer in the conversation has no say in it any more.)
                if (!message || !memberOf(await Conversation.findById(message.conversationKey).lean(), author.userId)) {
                    return fail(UNKNOWN_MESSAGE)
                }
                const deleted = await Message.findOneAndUpdate(
                    own, { $set: { kind: 'deleted' }, $unset: { text: 1, attachments: 1, clientId: 1 } },
                ).lean()
                if (!deleted) return fail(UNKNOWN_MESSAGE)
                if (attachments.enabled) await attachments.discardOfMessage(payload.id)

                // If it was the last thing said, its words must not stay under the
                // conversation's name in everyone's list.
                const conversationId = message.conversationKey
                const current = await Conversation.findOneAndUpdate(
                    { _id: conversationId, 'lastMessage.id': payload.id },
                    { $set: { 'lastMessage.preview': '', 'lastMessage.kind': 'deleted' }, $unset: { 'lastMessage.data': 1, 'lastMessage.attachments': 1 } },
                    { returnDocument: 'after' },
                ).lean() ?? await Conversation.findById(conversationId).lean()
                if (current) {
                    const position = positionOf(message)
                    const readers = current.members.filter(member => joinedBefore(member, position)).map(member => member.userId)
                    presence.tell(readers, 'messageDeleted', { conversationId, id: payload.id })
                    // Each member's view again: the preview, and an unread count that no longer includes it.
                    await tellMembers(current).catch(error => console.error("failed to describe a conversation:", error.name))
                }
                reply({ ok: true })
            } catch (error) {
                console.error("failed to delete a message:", error.name)
                fail('Could not be saved')
            }
        })
    }

    /**
     * An identity is gone. In each direct conversation their entry is kept, marked `gone`,
     * so the other person still sees whose chat it was — and is told, and can no longer
     * write to it.
     */
    const identityRemoved = async userId => {
        const conversations = await Conversation.find({ 'members.userId': userId, kind: 'direct' }, { _id: 1 }).lean()
        for (const { _id } of conversations) {
            const updated = await Conversation.findOneAndUpdate(
                { _id, 'members.userId': userId },
                { $set: { 'members.$.gone': true } },
                { returnDocument: 'after' },
            ).lean()
            if (updated) await tellMembers(updated)
        }
    }

    /**
     * A device has just been handed the user's conversation list: whatever is newest in
     * each has, in that sense, reached them — the badge is on their screen.
     */
    const listDelivered = async (userId, conversations) => {
        for (const conversation of conversations) {
            const position = lastPosition(conversation.lastMessage)
            if (position === null || conversation.lastMessage.from === userId) continue
            const own = memberOf(conversation, userId)
            if (comparePositions(position, own?.deliveredUpTo ?? null) <= 0) continue
            await advance(conversation.id, userId, 'deliveredUpTo', position)
        }
    }

    /** A user is visible again: what others are told about their reading catches up, once. */
    const visibleAgain = async userId => {
        for (const { conversation, publishedFrom } of await publishPositions(userId)) {
            await tellReceipt(conversation, userId, publishedFrom)
        }
    }

    return { registerOn, identityRemoved, listDelivered, visibleAgain, post, tellMembers, refusalToWrite }
}
