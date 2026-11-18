import { createAttemptLimiter } from '../auth/attempts.js'
import { refuse } from './validation.js'

// Guesses at a secret — a password, a recovery code, the bootstrap code — counted per
// client address and per (address, username), with a growing wait once the free ones
// are used up.

const waitText = ms => {
    const seconds = Math.ceil(ms / 1000)
    return seconds < 90 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`
}

/** `addressOf(socket)` is the client address the guesses are counted against. */
export const createGuessLimiter = ({ addressOf }) => {
    const failuresByAddress = createAttemptLimiter({ freeFailures: 20 })
    const failuresByPair = createAttemptLimiter({ freeFailures: 5 })

    /**
     * Runs one check of a guess for an (address, username), under the limits. `attempt`
     * resolves to something truthy when the guess was right; that is what this resolves
     * to as well. The attempt is counted from the moment it starts, not from when it
     * fails: the check is slow on purpose, and guesses sent all at once must not all get
     * in before the first has been counted.
     */
    const checkGuess = async (socket, username, attempt) => {
        const address = addressOf(socket)
        const pair = `${address}|${username}`
        const tooMany = wait => refuse(`Too many attempts. Try again in ${waitText(wait)}`, { retryAfterMs: wait })

        const addressWait = failuresByAddress.begin(address)
        if (addressWait > 0) tooMany(addressWait)
        const pairWait = failuresByPair.begin(pair)
        if (pairWait > 0) {
            failuresByAddress.end(address, { failed: false })
            tooMany(pairWait)
        }

        // Something that goes wrong while checking (the database, a full hashing queue)
        // is not a wrong guess: the attempt is released without being counted.
        let failed = false
        try {
            const result = await attempt()
            failed = !result
            // The address keeps its count: one right answer must not reset guessing at other names.
            if (result) failuresByPair.clear(pair)
            return result
        } finally {
            failuresByAddress.end(address, { failed })
            failuresByPair.end(pair, { failed })
        }
    }

    const prune = () => {
        failuresByAddress.prune()
        failuresByPair.prune()
    }

    return { checkGuess, prune }
}
