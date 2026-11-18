// Slows down guessing. Each key (a client address, or an address together with a username)
// gets a few free failures; after that every further failure blocks the key for twice as
// long as the one before, up to a ceiling. Kept in memory, one instance per app instance.
//
// There is deliberately no key for a username alone: anyone can read usernames in the
// sidebar, and could then keep an account's owner from signing in.
export const createAttemptLimiter = ({
    now = Date.now,
    freeFailures = 5,
    baseDelayMs = 1000,
    maxDelayMs = 15 * 60_000,
    forgetAfterMs = 60 * 60_000,
} = {}) => {
    // key → { failures, blockedUntil, lastFailureAt }
    const entries = new Map()

    const current = key => {
        const entry = entries.get(key)
        if (!entry) return null
        if (now() - entry.lastFailureAt > forgetAfterMs) {
            entries.delete(key)
            return null
        }
        return entry
    }

    /** Milliseconds until `key` may try again; 0 if it may try now. */
    const retryAfter = key => Math.max(0, (current(key)?.blockedUntil ?? 0) - now())

    const fail = key => {
        const entry = current(key) ?? { failures: 0, blockedUntil: 0, lastFailureAt: 0 }
        entry.failures += 1
        entry.lastFailureAt = now()
        if (entry.failures >= freeFailures) {
            const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (entry.failures - freeFailures))
            entry.blockedUntil = now() + delay
        }
        entries.set(key, entry)
    }

    const clear = key => {
        entries.delete(key)
    }

    /** Drops entries that have had no failure for `forgetAfterMs`. */
    const prune = () => {
        for (const key of entries.keys()) current(key)
    }

    return { retryAfter, fail, clear, prune, size: () => entries.size }
}
