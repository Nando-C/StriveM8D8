import { isDatabaseReady } from '../db.js'

// Usernames are restricted because two of them are joined with "::" to key a conversation.
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,30}$/

export const SLOW_DOWN = 'Too many requests, slow down'
export const NOT_LOGGED_IN = 'Not logged in'
export const COULD_NOT_BE_SAVED = 'Could not be saved'
// One answer for "no such conversation" and "not yours": which of the two it is says
// something about other people's conversations.
export const UNKNOWN_CONVERSATION = 'Unknown conversation'
export const MAX_CONVERSATION_ID_LENGTH = 200

export const isObject = value => typeof value === 'object' && value !== null

export const isNonEmptyString = (value, maxLength) =>
    typeof value === 'string' && value.length > 0 && value.length <= maxLength

export const isDocumentId = value => typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)

/**
 * What a handler was sent, and how it answers: `reply(answer)`, or `fail(message)` for
 * `{ ok: false, message }`. A client that sends only a callback delivers it as the first
 * argument.
 */
export const withAck = (rawPayload, rawAck) => {
    const callbackOnly = typeof rawPayload === 'function'
    const reply = callbackOnly ? rawPayload : typeof rawAck === 'function' ? rawAck : () => {}
    return { payload: callbackOnly ? undefined : rawPayload, reply, fail: message => reply({ ok: false, message }) }
}

// Thrown anywhere inside a handler to answer the client with a reason (and, in `extra`,
// anything else the answer should carry). Anything else that is thrown is a fault.
export class Refusal extends Error {
    constructor(message, extra = {}) {
        super(message)
        this.extra = extra
    }
}
export const refuse = (message, extra) => {
    throw new Refusal(message, extra)
}

/**
 * For a module's events that are asked by someone logged in and answered by an
 * acknowledgement: `answering(…)(socket)` is `on(event, limit, handler)`. The handler is
 * given `{ socket, user, payload }` (the payload always an object) and resolves to what
 * the answer carries, or refuses. `unavailable()` may give a reason nothing can be asked at all.
 */
export const answering = ({ presence, allowed, unavailable = () => null }) => socket => (event, limit, handler) => {
    socket.on(event, async (rawPayload, rawAck) => {
        const { payload, reply, fail } = withAck(rawPayload, rawAck)

        if (!allowed(socket, limit)) return fail(SLOW_DOWN)
        const user = presence.bySocket.get(socket.id)
        if (!user) return fail(NOT_LOGGED_IN)
        const off = unavailable()
        if (off) return fail(off)
        if (!isDatabaseReady()) return fail(COULD_NOT_BE_SAVED)
        try {
            const result = await handler({ socket, user, payload: isObject(payload) ? payload : {} })
            reply({ ok: true, ...result })
        } catch (error) {
            if (error instanceof Refusal) return fail(error.message)
            console.error(`${event} failed:`, error?.name)
            fail(COULD_NOT_BE_SAVED)
        }
    })
}
