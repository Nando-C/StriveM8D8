import { BOT, BOT_REPLY_DELAY_MS, botReply } from '../bot.js'
import { isDatabaseReady } from '../db.js'
import { Message, conversationKeyFor } from '../models/message.js'
import { createRateLimiter } from '../rateLimit.js'
import { createPresence } from './presence.js'
import { createSessionHandlers } from './session.js'
import {
    NOT_LOGGED_IN, SLOW_DOWN, USERNAME_PATTERN, isNonEmptyString, isObject, withAck,
} from './validation.js'

const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const MAX_TEXT_LENGTH = 2000
const MAX_ID_LENGTH = 100
const HISTORY_LIMIT = 100

// Per socket. Every event that costs something — a database write, a query, a broadcast
// to everyone — is capped. (The limits on signing in live in session.js.)
const RATE_LIMITS = {
    sendmessage: { limit: 10, windowMs: 10_000 },
    getHistory: { limit: 10, windowMs: 10_000 },
}

// Wires every socket event onto `io`. All state is created here, per call, so each app
// instance has its own. Returns read access to the public view of who is online, and the
// hourly housekeeping routine.
export const registerSocketHandlers = (io, settings) => {
    const presence = createPresence(io, { demoBot: settings.demoBot })
    const rateLimiter = createRateLimiter()
    const allowed = (socket, event) => rateLimiter.allow(socket.id, event, RATE_LIMITS[event])
    const session = createSessionHandlers({ presence, settings, rateLimiter })

    // Saves the bot's answer and delivers it to wherever the user is connected by then.
    const replyFromBot = async (to, text) => {
        try {
            if (!isDatabaseReady()) return
            const saved = await Message.create({
                conversationKey: conversationKeyFor(BOT.username, to.username),
                from: BOT.username,
                to: to.username,
                text,
            })
            const recipientNow = presence.users.get(to.userId)
            if (!recipientNow) return
            io.to([...recipientNow.sockets.keys()]).emit('message', {
                id: saved._id.toString(),
                from: BOT.username,
                fromId: BOT.id,
                text,
                timestamp: saved.createdAt.getTime(),
            })
        } catch (error) {
            console.error("demo bot failed to reply:", error.name)
        }
    }

    io.on('connection', socket => {
        console.log("socket connected:", socket.id)

        session.registerOn(socket)

        socket.on('sendmessage', async (rawPayload, rawAck) => {
            const { payload, reply } = withAck(rawPayload, rawAck)

            if (!allowed(socket, 'sendmessage')) {
                reply({ ok: false, message: SLOW_DOWN })
                return
            }

            if (
                !isObject(payload) ||
                !isNonEmptyString(payload.text, MAX_TEXT_LENGTH) ||
                !isNonEmptyString(payload.toUserId, MAX_ID_LENGTH) ||
                typeof payload.clientId !== 'string' ||
                !CLIENT_ID_PATTERN.test(payload.clientId)
            ) {
                reply({ ok: false, message: 'Invalid message' })
                return
            }
            const { toUserId, text, clientId } = payload

            // The sender's identity comes from the server's own state, never from the client.
            const sender = presence.bySocket.get(socket.id)
            if (!sender) {
                reply({ ok: false, message: NOT_LOGGED_IN })
                return
            }
            const recipient = presence.findByAddress(toUserId)
            if (recipient === sender) {
                reply({ ok: false, message: 'Cannot message yourself' })
                return
            }
            if (!recipient) {
                reply({ ok: false, message: 'Recipient is not online' })
                return
            }
            if (!isDatabaseReady()) {
                reply({ ok: false, message: 'Message could not be saved' })
                return
            }

            let saved
            try {
                saved = await Message.create({
                    conversationKey: conversationKeyFor(sender.username, recipient.username),
                    from: sender.username,
                    to: recipient.username,
                    text,
                    clientId,
                })
            } catch (error) {
                console.error("failed to save message:", error.name)
                reply({ ok: false, message: 'Message could not be saved' })
                return
            }

            const id = saved._id.toString()
            const timestamp = saved.createdAt.getTime()

            if (recipient.kind === 'bot') {
                // No socket to deliver to: the bot answers instead, a moment later.
                const turn = sender.botReplies
                sender.botReplies = turn + 1
                setTimeout(() => replyFromBot(sender, botReply(text, turn)), BOT_REPLY_DELAY_MS).unref()
                reply({ ok: true, id, timestamp })
                return
            }

            // Delivered only to the recipient's own connections, never broadcast. They are
            // looked up again: while the message was being saved the recipient may have
            // reconnected under a new socket id, or gone offline (it is then in their history).
            const recipientNow = presence.users.get(recipient.userId)
            if (recipientNow) {
                // `fromId` is the id the recipient knows the sender by, which is not
                // necessarily the socket this message came from.
                const fromId = presence.publicId(sender) ?? socket.id
                io.to([...recipientNow.sockets.keys()]).emit('message', { id, from: sender.username, fromId, text, timestamp })
            }
            reply({ ok: true, id, timestamp })
        })

        socket.on('getHistory', async payload => {
            const withUsername = isObject(payload) && typeof payload.withUsername === 'string'
                ? payload.withUsername
                : null
            const fail = message => socket.emit('historyError', { withUsername, message })

            if (!allowed(socket, 'getHistory')) {
                fail(SLOW_DOWN)
                return
            }

            if (withUsername === null || !USERNAME_PATTERN.test(withUsername)) {
                fail('Invalid username')
                return
            }
            // The requester's identity comes from the server's own state, never from the client.
            const requester = presence.bySocket.get(socket.id)
            if (!requester) {
                fail(NOT_LOGGED_IN)
                return
            }
            if (!isDatabaseReady()) {
                fail('History could not be loaded')
                return
            }

            let documents
            try {
                documents = await Message
                    .find({ conversationKey: conversationKeyFor(requester.username, withUsername) })
                    .sort({ createdAt: -1, _id: -1 })
                    .limit(HISTORY_LIMIT)
                    .lean()
            } catch (error) {
                console.error("failed to load history:", error.name)
                fail('History could not be loaded')
                return
            }

            const messages = documents.reverse().map(document => ({
                id: document._id.toString(),
                clientId: document.clientId ?? null,
                from: document.from,
                to: document.to,
                text: document.text,
                timestamp: document.createdAt.getTime(),
            }))

            socket.emit('history', { withUsername, messages })
        })

        socket.on('disconnect', () => {
            console.log("socket disconnected:", socket.id)
            rateLimiter.forget(socket.id)
            // Says nothing for a socket that never logged in, or one already replaced by
            // its user's newer connection.
            presence.detach(socket.id)
        })
    })

    return {
        getOnlineUsers: presence.getOnlineUsers,
        runMaintenance: session.runMaintenance,
        hasherStats: session.hasherStats,
    }
}
