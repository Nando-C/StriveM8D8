// The servers a browser is told to use to find a path between two people in a call.
//
// STUN lets each side learn its own public address, and is enough where a direct path
// exists. Where none does (many mobile and corporate networks), the call has to go
// through a relay — TURN — which costs its provider bandwidth, and so wants credentials.
// Those are short-lived, made per call by asking the provider's API with a key that
// never leaves this server.

/** Free, and needs no credentials. */
export const STUN_SERVERS = Object.freeze([{ urls: ['stun:stun.cloudflare.com:3478'] }])

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys'
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
 * fails: if the provider cannot be asked, the call is tried without a relay.
 */
export const createIceServers = ({ turn = null, ttlSeconds, fetch = (...request) => globalThis.fetch(...request) }) => async () => {
    if (turn === null) return [...STUN_SERVERS]
    try {
        const response = await fetch(`${API}/${encodeURIComponent(turn.keyId)}/credentials/generate-ice-servers`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${turn.apiToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttl: Math.min(MAX_TTL_SECONDS, Math.ceil(ttlSeconds)) }),
            signal: AbortSignal.timeout(API_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`status ${response.status}`)
        const { iceServers } = await response.json()
        const servers = Array.isArray(iceServers) ? iceServers.slice(0, MAX_URLS).map(serverIn).filter(Boolean) : []
        if (!servers.some(server => server.credential !== undefined)) throw new Error('no relay in the answer')
        return servers
    } catch (error) {
        // (Its name or status only: never the request, which carries the key.)
        console.error("failed to get relay credentials:", error?.name === 'Error' ? error.message : error?.name)
        return [...STUN_SERVERS]
    }
}
