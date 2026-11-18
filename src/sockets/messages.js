import { BOT, BOT_REPLY_DELAY_MS, botReply } from '../bot.js'
import {
    advancePosition, conversationViewFor, directConversationId, memberOf, parseDirectId, previewOf, publishPositions,
    receiptOf, visibleTo,
} from '../conversations.js'
import { isDatabaseReady } from '../db.js'
import { Conversation } from '../models/conversation.js'
import { Identity } from '../models/identity.js'
import { Message } from '../models/message.js'
import { beforePosition, comparePositions, isPosition, positionOf } from '../positions.js'
import { NOT_LOGGED_IN, SLOW_DOWN, isNonEmptyString, isObject, withAck } from './validation.js'

// Messages and the conversations they belong to. A message is addressed to a
// conversation, never to a person or a connection: whoever is in the conversation's
// stored member list gets it, on every device they have connected, and finds it in
// history if they are not connected at all.

const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const MAX_TEXT_LENGTH = 2000
const MAX_CONVERSATION_ID_LENGTH = 200
const HISTORY_PAGE = 100

// Per socket.
const RATE_LIMITS = {
    sendmessage: { limit: 10, windowMs: 10_000 },
    getHistory: { limit: 10, windowMs: 10_000 },
    markRead: { limit: 30, windowMs: 10_000 },
}

// One answer for "no such conversation" and "not yours": which of the two it is says
// something about other people's conversations.
const UNKNOWN_CONVERSATION = 'Unknown conversation'
const NOT_SAVED = 'Message could not be saved'
const NOT_LOADED = 'History could not be loaded'

const isDuplicateKey = error => error?.code === 11000

/** A stored message as `forUserId` receives it, live or in history: one shape for both. */
export const messageView = (message, forUserId) => ({
    id: message._id.toString(),
    conversationId: message.conversationKey,
    from: message.from,
    fromName: message.fromName,
    kind: message.kind ?? 'text',
    text: message.text ?? null,
    ...(message.data === undefined ? {} : { data: message.data }),
    timestamp: message.createdAt.getTime(),
    // Only its author can make use of the id their own client gave a message.
    clientId: message.from === forUserId ? message.clientId ?? null : null,
})

export const createMessageHandlers = ({ io, presence, settings, rateLimiter }) => {
    const allowed = (socket, event) => rateLimiter.allow(socket.id, event, RATE_LIMITS[event])

    const socketsOf = userId => [...(presence.users.get(userId)?.sockets.keys() ?? [])]

    // While a user is invisible, what others are told about their reading stands still.
    const mayPublish = userId => presence.users.get(userId)?.status !== 'invisible'

    /** Tells the other members, on every device they have connected, where `userId` now stands. */
    const tellReceipt = (conversation, userId) => {
        const sockets = conversation.members
            .filter(member => member.userId !== userId)
            .flatMap(member => socketsOf(member.userId))
        if (sockets.length > 0) io.to(sockets).emit('receipt', receiptOf(conversation, userId))
    }

    /**
     * Moves one member's delivered or read position forward and, if that changes what
     * others may know, tells them. Reading something implies having received it.
     * Resolves to whether the member's own (true) position moved.
     */
    const advance = async (conversationId, userId, field, position) => {
        const publish = mayPublish(userId)
        const fields = field === 'readUpTo' ? ['deliveredUpTo', 'readUpTo'] : ['deliveredUpTo']
        let moved = false
        let published = false
        for (const each of fields) {
            const result = await advancePosition(conversationId, userId, each, position, { publish })
            if (each === field) moved = result.moved
            published ||= result.published
        }
        if (published) {
            const fresh = await Conversation.findById(conversationId).lean()
            if (fresh) tellReceipt(fresh, userId)
        }
        return moved
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
        for (const member of conversation.members) {
            const sockets = socketsOf(member.userId)
            if (sockets.length === 0) continue
            io.to(sockets).emit('conversationUpdated', {
                conversation: await conversationViewFor(conversation, member.userId),
            })
        }
    }

    /**
     * Finds the direct conversation `id` for `sender`, creating it if this is its first
     * message. Resolves to { conversation, created } or { refusal }.
     */
    const openDirect = async (id, sender) => {
        // Created only when the id is exactly the pair of the sender and one other user
        // who exists. Anything else — a pair of two other people, a made-up id — is unknown.
        const pair = parseDirectId(id)
        if (pair === null || !pair.includes(sender.userId)) return { refusal: UNKNOWN_CONVERSATION }
        // (A well-formed id never names the same user twice, so there is always another.)
        const otherId = pair.find(userId => userId !== sender.userId)

        const other = otherId === BOT.id
            ? (settings.demoBot ? { userId: BOT.id, username: BOT.username } : null)
            : await Identity.findOne({ userId: otherId }, { userId: 1, username: 1 }).lean()
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
     */
    const post = async (conversation, author, { text, clientId, kind = 'text', data }, { exceptSocketId = null, created = false } = {}) => {
        const saved = await Message.create({
            conversationKey: conversation._id,
            from: author.userId,
            fromName: author.username,
            kind,
            text,
            data,
            clientId,
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
                        },
                        lastActivityAt: saved.createdAt,
                    },
                },
                { returnDocument: 'after' },
            ).lean()
            // Whoever wrote a message has read everything up to it.
            await advance(conversation._id, author.userId, 'readUpTo', position)
            // The bot has no device to acknowledge anything: what is said to it has reached it.
            if (settings.demoBot && author.userId !== BOT.id && memberOf(conversation, BOT.id) && conversation.kind === 'direct') {
                await advance(conversation._id, BOT.id, 'deliveredUpTo', position)
            }
        } catch (error) {
            console.error("failed to update a conversation after saving a message:", error.name)
        }

        for (const member of conversation.members) {
            const sockets = socketsOf(member.userId).filter(id => id !== exceptSocketId)
            if (sockets.length === 0) continue
            // The author's other devices are shown it; there is nothing to be delivered to its author.
            if (member.userId === author.userId) io.to(sockets).emit('message', messageView(saved, member.userId))
            else for (const socketId of sockets) deliver(saved, member, socketId)
        }
        // A conversation nobody has seen before is then described to each member in full
        // (who is in it, and their own unread count). It follows the message on purpose:
        // whatever a client worked out from the message alone, this replaces.
        if (created) await tellMembers(updated ?? conversation).catch(error => console.error("failed to describe a new conversation:", error.name))
        return saved
    }

    // The bot answers a moment later, in the same conversation, like anyone else would.
    const answerAsBot = (conversation, asker, text) => {
        const turn = asker.botReplies
        asker.botReplies = turn + 1
        setTimeout(async () => {
            try {
                if (!isDatabaseReady()) return
                await post(conversation, { userId: BOT.id, username: BOT.username }, { text: botReply(text, turn) })
            } catch (error) {
                console.error("demo bot failed to reply:", error.name)
            }
        }, BOT_REPLY_DELAY_MS).unref()
    }

    const registerOn = socket => {
        socket.on('sendmessage', async (rawPayload, rawAck) => {
            const { payload, reply } = withAck(rawPayload, rawAck)
            const fail = message => reply({ ok: false, message })

            if (!allowed(socket, 'sendmessage')) return fail(SLOW_DOWN)
            if (
                !isObject(payload) ||
                // A text message must have something in it.
                !isNonEmptyString(payload.text, MAX_TEXT_LENGTH) || payload.text.trim() === '' ||
                !isNonEmptyString(payload.conversationId, MAX_CONVERSATION_ID_LENGTH) ||
                typeof payload.clientId !== 'string' ||
                !CLIENT_ID_PATTERN.test(payload.clientId)
            ) {
                return fail('Invalid message')
            }
            const { conversationId, text, clientId } = payload

            // The sender's identity comes from the server's own state, never from the client.
            const sender = presence.bySocket.get(socket.id)
            if (!sender) return fail(NOT_LOGGED_IN)
            if (!isDatabaseReady()) return fail(NOT_SAVED)

            try {
                let conversation = await Conversation.findById(conversationId).lean()
                let created = false
                if (conversation) {
                    // Who may write here is decided by the stored members and nothing else.
                    if (!memberOf(conversation, sender.userId)) return fail(UNKNOWN_CONVERSATION)
                } else {
                    const opened = await openDirect(conversationId, sender)
                    if (opened.refusal) return fail(opened.refusal)
                    if (!opened.conversation || !memberOf(opened.conversation, sender.userId)) return fail(UNKNOWN_CONVERSATION)
                    ;({ conversation, created } = opened)
                }
                if (conversation.kind === 'direct' && conversation.members.some(member => member.gone)) {
                    return fail('This person is no longer here')
                }

                const saved = await post(conversation, sender, { text, clientId }, { exceptSocketId: socket.id, created })
                if (conversation.members.some(member => member.userId === BOT.id) && settings.demoBot) {
                    answerAsBot(conversation, sender, text)
                }
                reply({ ok: true, id: saved._id.toString(), timestamp: saved.createdAt.getTime() })
            } catch (error) {
                console.error("failed to save message:", error.name)
                fail(NOT_SAVED)
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
        // right at the next login; telling the other members is a later step.
        socket.on('markRead', async (rawPayload, rawAck) => {
            const { payload, reply } = withAck(rawPayload, rawAck)
            const fail = message => reply({ ok: false, message })

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
                const last = conversation.lastMessage?.id
                    ? { ts: conversation.lastMessage.timestamp, id: conversation.lastMessage.id }
                    : null
                if (last === null) return reply({ ok: true })
                const upTo = comparePositions(payload.upTo, last) > 0 ? last : { ts: payload.upTo.ts, id: payload.upTo.id }

                const moved = await advance(conversation._id, reader.userId, 'readUpTo', upTo)
                if (moved) {
                    // The reader's other devices drop their unread badge too.
                    const others = socketsOf(reader.userId).filter(id => id !== socket.id)
                    if (others.length > 0) {
                        const fresh = await Conversation.findById(conversation._id).lean()
                        if (fresh) io.to(others).emit('conversationUpdated', { conversation: await conversationViewFor(fresh, reader.userId) })
                    }
                }
                reply({ ok: true })
            } catch (error) {
                console.error("failed to save a read position:", error.name)
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
            const last = conversation.lastMessage
            if (last === null || last.from === userId) continue
            const own = conversation.members.find(member => member.userId === userId)
            const position = { ts: last.timestamp, id: last.id }
            if (comparePositions(position, own?.deliveredUpTo ?? null) <= 0) continue
            await advance(conversation.id, userId, 'deliveredUpTo', position)
        }
    }

    /** A user is visible again: what others are told about their reading catches up, once. */
    const visibleAgain = async userId => {
        for (const conversation of await publishPositions(userId)) tellReceipt(conversation, userId)
    }

    return { registerOn, identityRemoved, listDelivered, visibleAgain }
}
