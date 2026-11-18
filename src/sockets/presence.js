import { randomUUID } from 'node:crypto'
import { BOT } from '../bot.js'

// Who is connected right now, kept in memory, one instance per app instance.
//
// A user is online while at least one of their sockets is. A guest holds one socket; an
// account may hold several (one per device or tab). To everyone else a user is still a
// single `{ username, id }` entry, where `id` is the socket others address messages to:
// the user's longest-standing socket. If that socket closes while another remains, the
// entry is announced again with the new id, exactly like a reconnect.
//
// Each socket entry is { sessionToken, deviceSessionId }. Both are private to that socket:
// everything sent to other clients goes through getOnlineUsers().
export const createPresence = (io, { demoBot = false } = {}) => {
    /** userId → { userId, username, kind, admin, sockets: Map<socketId, entry>, botReplies } */
    const users = new Map()
    /** socketId → the same user object */
    const bySocket = new Map()

    // The demo bot is a permanent entry: it has no socket, so it never disconnects.
    const bot = { userId: BOT.id, username: BOT.username, kind: 'bot', admin: false, sockets: new Map(), botReplies: 0 }
    if (demoBot) users.set(bot.userId, bot)

    const publicId = user => (user.kind === 'bot' ? BOT.id : user.sockets.keys().next().value ?? null)
    const publicUser = user => ({ username: user.username, id: publicId(user) })
    const getOnlineUsers = () => [...users.values()].map(publicUser)

    /** The online user a client means by `id`: any of their sockets, or the bot. */
    const findByAddress = id => bySocket.get(id) ?? (demoBot && id === BOT.id ? bot : null)

    const tellEveryoneElse = (user, event, payload) => io.except([...user.sockets.keys()]).emit(event, payload)

    /**
     * Records `socket` as a connection of `identity` and announces the user if that is news
     * to anyone. `replaceSocketId` names one of the user's own sockets that this one takes
     * over from (a reconnect whose old connection the server has not noticed dropping yet):
     * it is closed without anyone being told the user left.
     */
    const attach = (socket, identity, { deviceSessionId = null, replaceSocketId = null } = {}) => {
        let user = users.get(identity.userId)
        const idBefore = user ? publicId(user) : null
        if (!user) {
            user = { userId: identity.userId, sockets: new Map(), botReplies: 0 }
            users.set(user.userId, user)
        }
        user.username = identity.username
        user.kind = identity.kind
        user.admin = identity.admin === true

        if (replaceSocketId !== null && user.sockets.has(replaceSocketId)) {
            user.sockets.delete(replaceSocketId)
            bySocket.delete(replaceSocketId)
            io.sockets.sockets.get(replaceSocketId)?.disconnect(true)
        }

        const sessionToken = randomUUID()
        user.sockets.set(socket.id, { sessionToken, deviceSessionId })
        bySocket.set(socket.id, user)

        if (publicId(user) !== idBefore) tellEveryoneElse(user, 'newLogin', publicUser(user))
        return { user, sessionToken }
    }

    /**
     * Forgets a socket. Others are told the user left only when it was their last one.
     * Returns the user it belonged to, or null if it was not logged in.
     */
    const detach = socketId => {
        const user = bySocket.get(socketId)
        if (!user) return null
        const idBefore = publicId(user)
        user.sockets.delete(socketId)
        bySocket.delete(socketId)

        if (user.sockets.size === 0) {
            users.delete(user.userId)
            io.except(socketId).emit('userLeft', { id: idBefore })
        } else if (publicId(user) !== idBefore) {
            tellEveryoneElse(user, 'newLogin', publicUser(user))
        }
        return user
    }

    /**
     * Ends connections on purpose: tells each socket why (`sessionRevoked`), forgets it and
     * closes it. `only` picks which of the user's sockets; `except` spares one socket id.
     */
    const revoke = (user, { reason, only = () => true, except = null } = {}) => {
        // (Deleting from a Map while iterating over it is safe.)
        for (const [socketId, entry] of user.sockets) {
            if (socketId === except || !only(entry)) continue
            const socket = io.sockets.sockets.get(socketId)
            socket?.emit('sessionRevoked', { reason })
            detach(socketId)
            socket?.disconnect(true)
        }
    }

    return { users, bySocket, publicId, getOnlineUsers, findByAddress, attach, detach, revoke }
}
