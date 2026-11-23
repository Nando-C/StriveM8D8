// The servers a browser is told to use to find a path between two people in a call.
//
// STUN lets each side learn its own public address, and is enough where a direct path
// exists. Where none does (many mobile and corporate networks), the call has to go
// through a relay — TURN — which costs its provider bandwidth, and so wants credentials.
// Those are short-lived, made per call by asking the provider's API with a key that
// never leaves this server.

/** Free, and needs no credentials. */
export const STUN_SERVERS = Object.freeze([{ urls: ['stun:stun.cloudflare.com:3478'] }])

/** Whether a list of servers has a relay among them (one comes with credentials). */
export const hasRelay = servers => servers.some(server => server.credential !== undefined)

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys'
// How long the provider is given, however many times it is asked: a browser waits for
// the answer before it begins to connect.
const API_TIMEOUT_MS = 5000
/** The longest the provider gives credentials for: 48 hours. */
const MAX_TTL_SECONDS = 48 * 60 * 60
const MAX_URLS = 20
const MAX_URL_LENGTH = 200
const MAX_SECRET_LENGTH = 500

const isShortString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max

// One entry of the provider's answer, as it is passed on — or null if it is not what an
// entry looks like. Nothing but these four fields ever reaches a client.
const serverIn = entry => {
    if (typeof entry !== 'object' || entry === null) return null
    const all = Array.isArray(entry.urls) ? entry.urls : [entry.urls]
    if (all.length > MAX_URLS || !all.every(url => isShortString(url, MAX_URL_LENGTH) && /^(stun|turn|turns):/.test(url))) return null
    // Browsers refuse to connect to port 53, and wait for it to time out first.
    const urls = all.filter(url => !/:53(\?|$)/.test(url))
    if (urls.length === 0) return null
    const { username, credential } = entry
    if (username === undefined && credential === undefined) return { urls }
    return isShortString(username, MAX_SECRET_LENGTH) && isShortString(credential, MAX_SECRET_LENGTH) ? { urls, username, credential } : null
}

/**
 * `turn` is `{ keyId, apiToken }`, or null where no relay is configured. Returns a
 * function resolving to the `iceServers` for one call, good for `ttlSeconds`. It never
 * fails: if the provider cannot be asked, the call is tried without a relay. A request
 * that went wrong at once (the provider out of reach, or in trouble: a 5xx) is made once
 * more within the same time, since a call between two networks with no direct path
 * depends on it; one that was refused, or that ran out of time, is not.
 */
export const createIceServers = ({ turn = null, ttlSeconds, fetch = (...request) => globalThis.fetch(...request) }) => {
    const ask = async signal => {
        const response = await fetch(`${API}/${encodeURIComponent(turn.keyId)}/credentials/generate-ice-servers`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${turn.apiToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttl: Math.min(MAX_TTL_SECONDS, Math.ceil(ttlSeconds)) }),
            signal,
        })
        if (!response.ok) throw Object.assign(new Error(`status ${response.status}`), { again: response.status >= 500 })
        const { iceServers } = await response.json()
        const servers = Array.isArray(iceServers) ? iceServers.slice(0, MAX_URLS).map(serverIn).filter(Boolean) : []
        if (!hasRelay(servers)) throw new Error('no relay in the answer')
        return servers
    }
    return async () => {
        if (turn === null) return [...STUN_SERVERS]
        const signal = AbortSignal.timeout(API_TIMEOUT_MS)
        // (Its name or status only: never the request, which carries the key.)
        const reasons = []
        const failed = error => reasons.push(error?.name === 'Error' ? error.message : error?.name)
        // (A request that could not be made at all is a TypeError.)
        const worthAnother = error => !signal.aborted && (error?.again === true || error?.name === 'TypeError')
        try {
            return await ask(signal).catch(error => {
                if (!worthAnother(error)) throw error
                failed(error)
                return ask(signal)
            })
        } catch (error) {
            failed(error)
            return [...STUN_SERVERS]
        } finally {
            // (Said also when the second request made up for the first: a provider in trouble is worth knowing of.)
            if (reasons.length > 0) console.error("failed to get relay credentials:", reasons.join(', then '))
        }
    }
}
