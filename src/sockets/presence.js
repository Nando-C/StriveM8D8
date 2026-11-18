import { randomUUID } from 'node:crypto'
import { BOT } from '../bot.js'

// Who is connected right now, kept in memory, one instance per app instance.
//
// A user is online while at least one of their sockets is. A guest holds one socket; an
// account may hold several (one per device or tab). To everyone else a user is a single
// `{ userId, username, kind }` entry: nobody outside this module learns a socket id.
//
// Each socket entry is { sessionToken, deviceSessionId }. Both are private to that socket:
// everything sent to other clients goes through getOnlineUsers().
export const createPresence = (io, { demoBot = false } = {}) => {
    /** userId → { userId, username, kind, admin, sockets: Map<socketId, entry>, botReplies } */
    const users = new Map()
    /** socketId → the same user object */
    const bySocket = new Map()

    // The demo bot is a permanent entry: it has no socket, so it never disconnects.
    if (demoBot) {
        users.set(BOT.id, { userId: BOT.id, username: BOT.username, kind: 'bot', admin: false, sockets: new Map(), botReplies: 0 })
    }

    const publicUser = user => ({ userId: user.userId, username: user.username, kind: user.kind })
    const getOnlineUsers = () => [...users.values()].map(publicUser)

    // Who is online is told only to sockets that are logged in as somebody. A connection
    // that never logged in learns nothing: on a deployment without guests it would
    // otherwise be handed every member's name just for connecting.
    const tellLoggedIn = (event, payload, { except = null } = {}) => {
        const sockets = [...bySocket.keys()].filter(socketId => !except?.has(socketId))
        if (sockets.length > 0) io.to(sockets).emit(event, payload)
    }

    /**
     * Records `socket` as a connection of `identity`, and announces the user if they were
     * not online already. `replaceSocketId` names one of the user's own sockets that this
     * one takes over from (a reconnect whose old connection the server has not noticed
     * dropping yet): it is closed without anyone being told the user left.
     */
    const attach = (socket, identity, { deviceSessionId = null, replaceSocketId = null } = {}) => {
        let user = users.get(identity.userId)
        const wasOnline = user !== undefined
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

        if (!wasOnline) tellLoggedIn('newLogin', publicUser(user), { except: user.sockets })
        return { user, sessionToken }
    }

    /**
     * Forgets a socket. Others are told the user left only when it was their last one.
     * Returns the user it belonged to, or null if it was not logged in.
     */
    const detach = socketId => {
        const user = bySocket.get(socketId)
        if (!user) return null
        user.sockets.delete(socketId)
        bySocket.delete(socketId)

        if (user.sockets.size === 0) {
            users.delete(user.userId)
            tellLoggedIn('userLeft', { userId: user.userId })
        }
        return user
    }

    /** A connected user's kind changed (a guest became an account): everyone's entry for them is replaced. */
    const announceChange = user => tellLoggedIn('newLogin', publicUser(user))

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

    return { users, bySocket, getOnlineUsers, publicUser, attach, detach, revoke, announceChange }
}
