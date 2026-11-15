import { randomUUID } from 'crypto'
import { isDatabaseReady } from '../db.js'
import { Message, conversationKeyFor } from '../models/message.js'

// Usernames are restricted because two of them are joined with "::" to key a conversation.
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,30}$/
const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const MAX_TEXT_LENGTH = 2000
const MAX_ID_LENGTH = 100
const HISTORY_LIMIT = 100

const isObject = value => typeof value === 'object' && value !== null
const isNonEmptyString = (value, maxLength) =>
    typeof value === 'string' && value.length > 0 && value.length <= maxLength

const publicUser = user => ({ username: user.username, id: user.id })

// Wires every socket event onto `io`. Presence state is created here, per call, so each
// app instance has its own. Returns read access to the public view of that state.
export const registerSocketHandlers = io => {
    // Entries are { username, id, sessionToken }. The token is private to its own socket:
    // everything sent to other clients goes through getOnlineUsers().
    let onlineUsers = []

    const getOnlineUsers = () => onlineUsers.map(publicUser)

    io.on('connection', socket => {
        console.log(socket.id)

        socket.on('login', payload => {
            const username = isObject(payload) && typeof payload.username === 'string'
                ? payload.username.trim()
                : ''

            if (!USERNAME_PATTERN.test(username)) {
                socket.emit('loginError', { message: 'Invalid username' })
                return
            }

            const current = onlineUsers.find(user => user.id === socket.id)
            if (current && current.username !== username) {
                socket.emit('loginError', { message: 'Already logged in' })
                return
            }

            const holder = onlineUsers.find(user => user.username === username && user.id !== socket.id)
            if (holder) {
                // The same user coming back on a new connection proves it with the token
                // issued at their previous login, and takes over the stale entry.
                if (typeof payload.sessionToken !== 'string' || payload.sessionToken !== holder.sessionToken) {
                    socket.emit('loginError', { message: 'Username already in use' })
                    return
                }
                onlineUsers = onlineUsers.filter(user => user.id !== holder.id)
                io.sockets.sockets.get(holder.id)?.disconnect(true)
            }

            const sessionToken = randomUUID()
            onlineUsers = onlineUsers.filter(user => user.id !== socket.id)
            onlineUsers.push({ username, id: socket.id, sessionToken })

            socket.emit('loggedin', { username, id: socket.id, sessionToken, onlineUsers: getOnlineUsers() })
            // A repeat login by the same socket changes nothing for anyone else.
            if (!current) {
                socket.broadcast.emit('newLogin', { username, id: socket.id })
            }
        })

        socket.on('sendmessage', async (payload, ack) => {
            // A client that sends only a callback delivers it as the first argument.
            if (typeof payload === 'function') {
                ack = payload
                payload = undefined
            }
            const reply = typeof ack === 'function' ? ack : () => {}

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

            const sender = onlineUsers.find(user => user.id === socket.id)
            if (!sender) {
                reply({ ok: false, message: 'Not logged in' })
                return
            }
            if (toUserId === socket.id) {
                reply({ ok: false, message: 'Cannot message yourself' })
                return
            }
            const recipient = onlineUsers.find(user => user.id === toUserId)
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

            // Delivered only into the recipient's own room, never broadcast.
            socket.to(toUserId).emit('message', { id, from: sender.username, fromId: socket.id, text, timestamp })
            reply({ ok: true, id, timestamp })
        })

        socket.on('getHistory', async payload => {
            const withUsername = isObject(payload) && typeof payload.withUsername === 'string'
                ? payload.withUsername
                : null
            const fail = message => socket.emit('historyError', { withUsername, message })

            if (withUsername === null || !USERNAME_PATTERN.test(withUsername)) {
                fail('Invalid username')
                return
            }
            // The requester's identity comes from the server's own state, never from the client.
            const requester = onlineUsers.find(user => user.id === socket.id)
            if (!requester) {
                fail('Not logged in')
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
            onlineUsers = onlineUsers.filter(user => user.id !== socket.id)
        })
    })

    return { getOnlineUsers }
}
