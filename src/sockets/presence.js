import { randomUUID } from 'node:crypto'
import { BOT } from '../bot.js'
import { BOT_STATUS_TEXT, publicPresence } from '../status.js'

// Who is connected right now, kept in memory, one instance per app instance.
//
// A user is online while at least one of their sockets is. A guest holds one socket; an
// account may hold several (one per device or tab). To everyone else a user is a single
// `{ userId, username, kind, status, statusText }` entry — or nothing at all, if they
// have chosen to be invisible. Nobody outside this module learns a socket id.
//
// Each socket entry is { sessionToken, deviceSessionId, idle }. All private to that
// socket: everything sent to other clients goes through `publicUser`.
export const createPresence = (io, { demoBot = false } = {}) => {
    /** userId → { userId, username, kind, admin, status, statusText, statusClearAt, sockets, botReplies } */
    const users = new Map()
    /** socketId → the same user object */
    const bySocket = new Map()
    /**
     * Told when a user's first socket connects and when their last one goes (status.js
     * keeps timers by it), and when any logged-in socket stops being one (calls.js).
     */
    const hooks = { online: () => {}, offline: () => {}, detached: () => {} }

    // The demo bot is a permanent entry: it has no socket, so it never disconnects.
    if (demoBot) {
        users.set(BOT.id, {
            userId: BOT.id, username: BOT.username, kind: 'bot', admin: false,
            status: 'online', statusText: BOT_STATUS_TEXT, statusClearAt: null,
            sockets: new Map(), botReplies: 0,
        })
    }

    // Idle only when every device is: someone typing on their laptop is not away because
    // their phone is in their pocket. (The bot has no devices, and is never idle.)
    const isIdle = user => user.sockets.size > 0 && [...user.sockets.values()].every(entry => entry.idle)

    /** A user as everyone else is shown them, or null if they are shown to nobody. */
    const publicUser = user => {
        const shown = publicPresence({ status: user.status, statusText: user.statusText, idle: isIdle(user) })
        return shown === null ? null : { userId: user.userId, username: user.username, kind: user.kind, ...shown }
    }
    const getOnlineUsers = () => [...users.values()].map(publicUser).filter(Boolean)

    /** Whether others may be told anything new about this user. (Someone not connected: yes.) */
    const isShown = userId => {
        const user = users.get(userId)
        return !user || publicUser(user) !== null
    }

    const socketsOf = userId => [...(users.get(userId)?.sockets.keys() ?? [])]

    /**
     * Sends an event to every connected device of these users, and to nobody when there
     * are none. The one way to address people: an emit to an empty list of sockets goes
     * to every connection there is, so that case must never be left to the caller.
     */
    const tell = (userIds, event, payload, { exceptSocketId = null } = {}) => {
        const sockets = userIds.flatMap(socketsOf).filter(socketId => socketId !== exceptSocketId)
        if (sockets.length > 0) io.to(sockets).emit(event, payload)
    }

    /**
     * The same for particular devices — for what concerns one device of a user and not
     * the others (a call). Only to sockets that are logged in, and to nobody when none is.
     */
    const tellSockets = (socketIds, event, payload) => {
        const sockets = socketIds.filter(socketId => bySocket.has(socketId))
        if (sockets.length > 0) io.to(sockets).emit(event, payload)
    }

    // Who is online is told only to sockets that are logged in as somebody. A connection
    // that never logged in learns nothing: on a deployment without guests it would
    // otherwise be handed every member's name just for connecting.
    const tellLoggedIn = (event, payload, { except = null } = {}) => {
        const sockets = [...bySocket.keys()].filter(socketId => !except?.has(socketId))
        if (sockets.length > 0) io.to(sockets).emit(event, payload)
    }

    // Tells everyone else what changed in how a user is shown, given how they were shown
    // before. The user's own connections are not told: they know what they chose.
    const announce = (user, before) => {
        const after = users.has(user.userId) ? publicUser(user) : null
        const others = { except: user.sockets }
        if (before === null && after === null) return
        if (before === null) tellLoggedIn('newLogin', after, others)
        else if (after === null) tellLoggedIn('userLeft', { userId: user.userId }, others)
        else if (before.kind !== after.kind || before.username !== after.username) tellLoggedIn('newLogin', after, others)
        else if (before.status !== after.status || before.statusText !== after.statusText) {
            tellLoggedIn('presence', { userId: user.userId, status: after.status, statusText: after.statusText }, others)
        }
    }

    /**
     * Changes something about a connected user (their status, an idle flag, their kind)
     * and tells everyone else exactly what that changes for them — which, for someone
     * invisible, is nothing. Returns how they were shown `before` and are shown `after`
     * (null: to nobody).
     */
    const update = (user, change) => {
        const before = users.has(user.userId) ? publicUser(user) : null
        change(user)
        announce(user, before)
        return { before, after: users.has(user.userId) ? publicUser(user) : null }
    }

    /**
     * Records `socket` as a connection of `identity`, and announces the user if that makes
     * them appear. `replaceSocketId` names one of the user's own sockets that this one
     * takes over from (a reconnect whose old connection the server has not noticed
     * dropping yet): it is closed without anyone being told the user left.
     */
    const attach = (socket, identity, { deviceSessionId = null, replaceSocketId = null } = {}) => {
        let user = users.get(identity.userId)
        const first = user === undefined
        const before = first ? null : publicUser(user)
        if (first) {
            user = {
                userId: identity.userId, sockets: new Map(), botReplies: 0,
                // What was chosen is taken from storage when the user comes online; while
                // they are online the copy here is the one that is kept up to date.
                status: identity.status ?? 'online',
                statusText: identity.statusText ?? '',
                statusClearAt: identity.statusClearAt ?? null,
            }
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
        // A connection that has just logged in is in use.
        user.sockets.set(socket.id, { sessionToken, deviceSessionId, idle: false })
        bySocket.set(socket.id, user)

        if (first) hooks.online(user)
        announce(user, before)
        return { user, sessionToken }
    }

    /**
     * Forgets a socket. Others are told the user left only when it was their last one
     * (and only if they could see the user at all). Returns the user it belonged to, or
     * null if it was not logged in.
     */
    const detach = socketId => {
        const user = bySocket.get(socketId)
        if (!user) return null
        const before = publicUser(user)
        user.sockets.delete(socketId)
        bySocket.delete(socketId)
        hooks.detached(socketId)

        if (user.sockets.size === 0) {
            users.delete(user.userId)
            hooks.offline(user)
        }
        announce(user, before)
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

    return { users, bySocket, hooks, getOnlineUsers, publicUser, isShown, socketsOf, tell, tellSockets, attach, detach, revoke, update }
}
