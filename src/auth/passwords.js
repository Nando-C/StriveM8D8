import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// Passwords and recovery codes are hashed with scrypt, which is built into Node: nothing
// native for a host to compile.
//
// The parameters are one of the equivalent settings in OWASP's Password Storage Cheat
// Sheet (checked 2026-11-18): N=2^15, r=8, p=3. It needs about 32 MiB per hash, where the
// headline setting (N=2^17, p=1) needs 128 MiB — too much for a server with 512 MB in all.
// They are stored with every hash, so they can be raised later without invalidating
// existing passwords.
export const DEFAULT_PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 3 })

const KEY_LENGTH = 32
const SALT_LENGTH = 16
// Refuse to work with parameters far beyond anything this server would have written.
const MAX_N = 2 ** 17

export class HasherBusyError extends Error {
    constructor() {
        super('password hasher is busy')
        this.name = 'HasherBusyError'
    }
}

const derive = (secret, salt, { N, r, p }) => new Promise((resolve, reject) => {
    // scrypt needs roughly 128 * N * r bytes; Node's default ceiling is exactly 32 MiB.
    const options = { N, r, p, maxmem: 256 * N * r }
    scrypt(secret.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)))
})

const parse = stored => {
    if (typeof stored !== 'string') return null
    const [scheme, N, r, p, salt, key] = stored.split('$')
    if (scheme !== 'scrypt' || !salt || !key) return null
    const params = { N: Number(N), r: Number(r), p: Number(p) }
    const sane = Number.isInteger(params.N) && params.N >= 2 && params.N <= MAX_N
        && Number.isInteger(params.r) && params.r >= 1 && params.r <= 16
        && Number.isInteger(params.p) && params.p >= 1 && params.p <= 16
    if (!sane) return null
    return { params, salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') }
}

/**
 * Hashes and verifies secrets, at most `concurrency` at a time. Each hash holds tens of
 * megabytes while it runs, so a burst of sign-ins is queued rather than run all at once;
 * beyond `maxWaiting` queued requests, new ones are refused with HasherBusyError.
 */
export const createPasswordHasher = ({ params = DEFAULT_PARAMS, concurrency = 2, maxWaiting = 50 } = {}) => {
    let running = 0
    let peak = 0
    const waiting = []

    const run = task => new Promise((resolve, reject) => {
        const start = () => {
            running += 1
            peak = Math.max(peak, running)
            task().then(resolve, reject).finally(() => {
                running -= 1
                waiting.shift()?.()
            })
        }
        if (running < concurrency) start()
        else if (waiting.length >= maxWaiting) reject(new HasherBusyError())
        else waiting.push(start)
    })

    /** → "scrypt$N$r$p$salt$key" */
    const hash = secret => run(async () => {
        const salt = randomBytes(SALT_LENGTH)
        const key = await derive(secret, salt, params)
        return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$')
    })

    /**
     * Whether `secret` matches `stored`. With nothing valid stored (an unknown user) it
     * still does the same work, so the time taken does not say whether the account exists.
     */
    const verify = (secret, stored) => run(async () => {
        const parsed = parse(stored)
        if (parsed === null) {
            await derive(secret, randomBytes(SALT_LENGTH), params)
            return false
        }
        const key = await derive(secret, parsed.salt, parsed.params)
        return key.length === parsed.key.length && timingSafeEqual(key, parsed.key)
    })

    const stats = () => ({ running, waiting: waiting.length, peak })

    return { hash, verify, stats }
}
