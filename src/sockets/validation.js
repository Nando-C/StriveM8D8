// Usernames are restricted because two of them are joined with "::" to key a conversation.
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,30}$/

export const SLOW_DOWN = 'Too many requests, slow down'
export const NOT_LOGGED_IN = 'Not logged in'

export const isObject = value => typeof value === 'object' && value !== null

export const isNonEmptyString = (value, maxLength) =>
    typeof value === 'string' && value.length > 0 && value.length <= maxLength

// A client that sends only a callback delivers it as the first argument.
export const withAck = (payload, ack) => {
    if (typeof payload === 'function') return { payload: undefined, reply: payload }
    return { payload, reply: typeof ack === 'function' ? ack : () => {} }
}
