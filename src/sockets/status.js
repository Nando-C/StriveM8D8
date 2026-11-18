import { isDatabaseReady } from '../db.js'
import { Identity } from '../models/identity.js'
import { MAX_CLEAR_AFTER_MINUTES, MAX_STATUS_TEXT_LENGTH, cleanStatusText, isStatus } from '../status.js'
import { NOT_LOGGED_IN, SLOW_DOWN, isObject, withAck } from './validation.js'

// Status: what a user chooses to show (online, away, do not disturb, invisible, and a
// line of text), and whether they are idle. What everyone else is then shown — or not
// shown — is decided in ../status.js and announced by presence.js; this file only
// changes the user's own state and keeps it stored.

// Per socket.
const RATE_LIMITS = {
    setStatus: { limit: 10, windowMs: 10_000 },
    // Sent when someone starts or stops using the page: a few a minute at most.
    setIdle: { limit: 30, windowMs: 10_000 },
}

/** A user's own status, as only they are told it. */
export const ownStatus = user => ({
    status: user.status,
    statusText: user.statusText,
    statusClearAt: user.statusClearAt ? new Date(user.statusClearAt).getTime() : null,
})

export const createStatusHandlers = ({ io, presence, rateLimiter }) => {
    const allowed = (socket, event) => rateLimiter.allow(socket.id, event, RATE_LIMITS[event])

    /** userId → the timer that clears their status text. Only for users who are connected. */
    const timers = new Map()

    const tellOwnDevices = (user, { except = null } = {}) => {
        const sockets = [...user.sockets.keys()].filter(socketId => socketId !== except)
        if (sockets.length > 0) io.to(sockets).emit('ownStatus', ownStatus(user))
    }

    // The text has run its time: it goes, everywhere — storage, everyone who could see
    // it, and the user's own devices. The chosen status stays.
    const clearText = async user => {
        timers.delete(user.userId)
        presence.update(user, changing => {
            changing.statusText = ''
            changing.statusClearAt = null
        })
        tellOwnDevices(user)
        try {
            if (isDatabaseReady()) await Identity.updateOne({ userId: user.userId }, { statusText: '', statusClearAt: null })
        } catch (error) {
            // It is cleared again at the user's next login, where it is checked once more.
            console.error("failed to store a cleared status:", error.name)
        }
    }

    const schedule = user => {
        clearTimeout(timers.get(user.userId))
        timers.delete(user.userId)
        if (!user.statusClearAt) return
        const delay = new Date(user.statusClearAt).getTime() - Date.now()
        // Already due — it expired while the user was away.
        if (delay <= 0) {
            void clearText(user)
            return
        }
        const timer = setTimeout(() => void clearText(user), delay)
        // Never the reason the process stays alive.
        timer.unref()
        timers.set(user.userId, timer)
    }

    presence.hooks.online = user => {
        // Before anyone is told about them: a text that ran out while they were away is
        // never announced. (Storing that is all that is left for `schedule` to do.)
        if (user.statusClearAt && new Date(user.statusClearAt).getTime() <= Date.now()) user.statusText = ''
        schedule(user)
    }
    presence.hooks.offline = user => {
        clearTimeout(timers.get(user.userId))
        timers.delete(user.userId)
    }

    const registerOn = socket => {
        socket.on('setStatus', async (rawPayload, rawAck) => {
            const { payload, reply } = withAck(rawPayload, rawAck)
            const fail = message => reply({ ok: false, message })

            if (!allowed(socket, 'setStatus')) return fail(SLOW_DOWN)
            if (!isObject(payload)) return fail('Invalid status')
            const { status, text, clearAfterMinutes } = payload
            if (status !== undefined && !isStatus(status)) return fail('Invalid status')
            if (text !== undefined && typeof text !== 'string') return fail('Invalid status')
            const cleaned = text === undefined ? undefined : cleanStatusText(text)
            if (cleaned !== undefined && cleaned.length > MAX_STATUS_TEXT_LENGTH) {
                return fail(`A status message can be at most ${MAX_STATUS_TEXT_LENGTH} characters`)
            }
            // null or absent: the text stays until it is changed.
            const timed = clearAfterMinutes !== undefined && clearAfterMinutes !== null
            if (timed && !(Number.isInteger(clearAfterMinutes) && clearAfterMinutes >= 1 && clearAfterMinutes <= MAX_CLEAR_AFTER_MINUTES)) {
                return fail('Invalid status')
            }

            const user = presence.bySocket.get(socket.id)
            if (!user) return fail(NOT_LOGGED_IN)
            if (!isDatabaseReady()) return fail('Status could not be saved')

            const next = {
                status: status ?? user.status,
                statusText: cleaned ?? user.statusText,
                statusClearAt: user.statusClearAt,
            }
            // A new text, or a new lifetime for the one there is. An empty text has none.
            if (cleaned !== undefined || clearAfterMinutes !== undefined) {
                next.statusClearAt = timed && next.statusText !== '' ? new Date(Date.now() + clearAfterMinutes * 60_000) : null
            }

            try {
                // Stored first: what is announced is then never ahead of what a reload would show.
                await Identity.updateOne({ userId: user.userId }, { $set: next })
            } catch (error) {
                console.error("failed to store a status:", error.name)
                return fail('Status could not be saved')
            }
            // The user may have gone while that was being stored; there is then nobody to tell.
            if (presence.users.get(user.userId) === user) {
                presence.update(user, changing => Object.assign(changing, next))
                schedule(user)
                tellOwnDevices(user, { except: socket.id })
            }
            reply({ ok: true, ...ownStatus({ ...user, ...next }) })
        })

        // "Nobody is using this page" / "somebody is again". Kept in memory only: it says
        // something about a connection, and goes with it.
        socket.on('setIdle', (rawPayload, rawAck) => {
            const { payload, reply } = withAck(rawPayload, rawAck)
            if (!allowed(socket, 'setIdle')) return reply({ ok: false, message: SLOW_DOWN })
            if (!isObject(payload) || typeof payload.idle !== 'boolean') return reply({ ok: false, message: 'Invalid request' })
            const user = presence.bySocket.get(socket.id)
            if (!user) return reply({ ok: false, message: NOT_LOGGED_IN })

            presence.update(user, changing => {
                changing.sockets.get(socket.id).idle = payload.idle
            })
            reply({ ok: true })
        })
    }

    return { registerOn }
}
