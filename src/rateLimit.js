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

    /**
     * Drops every owner that has made no call for `idleMs`. Owners that are connections
     * are forgotten when they close; owners that are client addresses never close, and
     * would otherwise be remembered for as long as the process runs.
     */
    const prune = idleMs => {
        const cutoff = now() - idleMs
        for (const [owner, byKey] of calls) {
            const newest = Math.max(0, ...[...byKey.values()].map(times => times.at(-1) ?? 0))
            if (newest <= cutoff) calls.delete(owner)
        }
    }

    /** For a module's own table of per-socket limits: `(socket, key)` → whether it may. */
    const perSocket = limits => (socket, key) => allow(socket.id, key, limits[key])

    return { allow, perSocket, forget, prune, owners: () => calls.size }
}
