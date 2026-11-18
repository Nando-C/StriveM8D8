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
    // key → { failures, blockedUntil, lastFailureAt, inFlight }
    const entries = new Map()
    const blank = () => ({ failures: 0, blockedUntil: 0, lastFailureAt: now(), inFlight: 0 })

    const current = key => {
        const entry = entries.get(key)
        if (!entry) return null
        if (entry.inFlight === 0 && now() - entry.lastFailureAt > forgetAfterMs) {
            entries.delete(key)
            return null
        }
        return entry
    }

    /** Milliseconds until `key` may try again; 0 if it may try now. */
    const retryAfter = key => Math.max(0, (current(key)?.blockedUntil ?? 0) - now())

    /**
     * Asks to make one attempt. Returns 0 and counts it as under way, or the milliseconds
     * to wait. Attempts that are still being checked count against the free allowance:
     * a check takes a while (the password hash is slow on purpose), and without this a
     * burst of guesses sent at once would all be let in before the first had failed.
     * Once the allowance is used up, one attempt at a time. Every `begin` that returns 0
     * must be matched by one `end`.
     */
    const begin = key => {
        const wait = retryAfter(key)
        if (wait > 0) return wait
        const entry = current(key) ?? blank()
        if (entry.inFlight >= Math.max(1, freeFailures - entry.failures)) return baseDelayMs
        entry.inFlight += 1
        entries.set(key, entry)
        return 0
    }

    /** The attempt begun earlier is over. `failed`: it was a wrong guess. */
    const end = (key, { failed }) => {
        const entry = entries.get(key)
        if (entry) entry.inFlight = Math.max(0, entry.inFlight - 1)
        if (failed) fail(key)
    }

    const fail = key => {
        const entry = current(key) ?? blank()
        entry.failures += 1
        entry.lastFailureAt = now()
        if (entry.failures >= freeFailures) {
            const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (entry.failures - freeFailures))
            entry.blockedUntil = now() + delay
        }
        entries.set(key, entry)
    }

    /** Forgets the failures counted against `key` (attempts still under way stay counted). */
    const clear = key => {
        const entry = entries.get(key)
        if (!entry) return
        if (entry.inFlight === 0) entries.delete(key)
        else Object.assign(entry, { failures: 0, blockedUntil: 0 })
    }

    /** Drops entries that have had no failure for `forgetAfterMs`. */
    const prune = () => {
        for (const key of entries.keys()) current(key)
    }

    return { retryAfter, begin, end, fail, clear, prune, size: () => entries.size }
}
