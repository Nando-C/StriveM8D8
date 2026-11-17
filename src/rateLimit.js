// A sliding-window rate limiter, kept in memory. `allow(owner, key, …)` answers whether
// `owner` may do `key` once more, and records it if so. One instance per app instance.
export const createRateLimiter = (now = Date.now) => {
    // owner → key → timestamps of the calls still inside the window
    const calls = new Map()

    const allow = (owner, key, { limit, windowMs }) => {
        if (!calls.has(owner)) calls.set(owner, new Map())
        const byKey = calls.get(owner)

        const cutoff = now() - windowMs
        const recent = (byKey.get(key) ?? []).filter(time => time > cutoff)

        if (recent.length >= limit) {
            byKey.set(key, recent)
            return false
        }
        recent.push(now())
        byKey.set(key, recent)
        return true
    }

    /** Drop everything remembered about `owner` (for example, a socket that has gone). */
    const forget = owner => {
        calls.delete(owner)
    }

    return { allow, forget }
}
