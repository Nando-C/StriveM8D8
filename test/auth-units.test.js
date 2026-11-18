import { describe, expect, it, vi } from 'vitest'
import { createAttemptLimiter } from '../src/auth/attempts.js'
import { DEFAULT_PARAMS, HasherBusyError, createPasswordHasher } from '../src/auth/passwords.js'
import { fingerprint, newRecoveryCode, newSecret, normaliseRecoveryCode, sameString } from '../src/auth/secrets.js'
import { clientAddress } from '../src/clientAddress.js'
import { resolveSettings, settingsFromEnv } from '../src/settings.js'

// No server and no database: the building blocks under the account handlers.
const FAST = { N: 2 ** 10, r: 8, p: 1 }

describe('password hashing', () => {
    it('verifies the right password and no other', async () => {
        const hasher = createPasswordHasher({ params: FAST })

        const stored = await hasher.hash('correct horse battery')

        expect(await hasher.verify('correct horse battery', stored)).toBe(true)
        expect(await hasher.verify('correct horse batterx', stored)).toBe(false)
        expect(await hasher.verify('', stored)).toBe(false)
    })

    it('salts: the same password never hashes to the same string, and the string does not contain it', async () => {
        const hasher = createPasswordHasher({ params: FAST })

        const [first, second] = await Promise.all([hasher.hash('same password'), hasher.hash('same password')])

        expect(first).not.toBe(second)
        expect(first).not.toContain('same password')
        expect(first).toMatch(/^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/)
    })

    it('verifies with the parameters stored in the hash, not its own', async () => {
        const stored = await createPasswordHasher({ params: FAST }).hash('a password')
        const stronger = createPasswordHasher({ params: { N: 2 ** 11, r: 8, p: 1 } })

        expect(await stronger.verify('a password', stored)).toBe(true)
        expect(await stronger.hash('a password')).toMatch(/^scrypt\$2048\$/)
    })

    it('answers false, after doing the work, when nothing valid is stored', async () => {
        const hasher = createPasswordHasher({ params: FAST })

        for (const stored of [null, undefined, '', 'plain', 'scrypt$0$8$1$abc$def', 'scrypt$1048576$8$1$abc$def', 'bcrypt$1$2$3$a$b']) {
            expect(await hasher.verify('anything', stored)).toBe(false)
        }
    })

    it('never runs more than two at once, however many are asked for', async () => {
        const hasher = createPasswordHasher({ params: FAST })

        const all = Promise.all(Array.from({ length: 12 }, (_unused, index) => hasher.hash(`password ${index}`)))
        expect(hasher.stats().running).toBe(2)
        expect(hasher.stats().waiting).toBe(10)
        const hashes = await all

        expect(new Set(hashes).size).toBe(12)
        expect(hasher.stats()).toEqual({ running: 0, waiting: 0, peak: 2 })
    })

    it('refuses new work once the queue is full, and recovers', async () => {
        const hasher = createPasswordHasher({ params: FAST, concurrency: 1, maxWaiting: 2 })

        const accepted = [hasher.hash('a'), hasher.hash('b'), hasher.hash('c')]
        await expect(hasher.hash('d')).rejects.toBeInstanceOf(HasherBusyError)
        await Promise.all(accepted)

        expect(await hasher.hash('e')).toMatch(/^scrypt\$/)
    })

    it('uses a setting from the OWASP list that fits a small server by default', () => {
        expect(DEFAULT_PARAMS).toEqual({ N: 2 ** 15, r: 8, p: 3 })
    })
})

describe('secrets', () => {
    it('are long, unique, and stored only as a fingerprint that does not contain them', () => {
        const first = newSecret()
        const second = newSecret()

        expect(first).not.toBe(second)
        expect(first.length).toBeGreaterThanOrEqual(43)
        expect(fingerprint(first)).toMatch(/^[0-9a-f]{64}$/)
        expect(fingerprint(first)).not.toContain(first)
    })

    it('compares strings, and only strings', () => {
        expect(sameString('abc', 'abc')).toBe(true)
        expect(sameString('abc', 'abd')).toBe(false)
        expect(sameString('abc', 'abcd')).toBe(false)
        expect(sameString(undefined, undefined)).toBe(false)
        expect(sameString('abc', { toString: () => 'abc' })).toBe(false)
    })

    it('makes recovery codes of 20 unambiguous symbols, forgiving about how they are typed back', () => {
        const code = newRecoveryCode()

        expect(code).toMatch(/^([A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/)
        expect(normaliseRecoveryCode(` ${code.toLowerCase().replaceAll('-', ' ')} `)).toBe(code.replaceAll('-', ''))
        expect(newRecoveryCode()).not.toBe(code)
    })
})

describe('attempt limiter', () => {
    const setup = options => {
        const clock = { now: 0 }
        return { clock, limiter: createAttemptLimiter({ now: () => clock.now, ...options }) }
    }

    it('allows a few failures, then makes each further one wait twice as long', () => {
        const { clock, limiter } = setup({ freeFailures: 3, baseDelayMs: 1000 })

        limiter.fail('k')
        limiter.fail('k')
        expect(limiter.retryAfter('k')).toBe(0)

        limiter.fail('k')
        expect(limiter.retryAfter('k')).toBe(1000)
        clock.now += 1000
        expect(limiter.retryAfter('k')).toBe(0)

        limiter.fail('k')
        expect(limiter.retryAfter('k')).toBe(2000)
        clock.now += 2000
        limiter.fail('k')
        expect(limiter.retryAfter('k')).toBe(4000)
    })

    it('counts attempts that are still being checked against the free allowance', () => {
        const { clock, limiter } = setup({ freeFailures: 3, baseDelayMs: 1000 })

        // Three may be under way at once; a fourth has to wait for one of them.
        expect([limiter.begin('k'), limiter.begin('k'), limiter.begin('k')]).toEqual([0, 0, 0])
        expect(limiter.begin('k')).toBe(1000)
        expect(limiter.begin('other')).toBe(0)

        // Two turn out wrong, one right: one free guess is left, so one at a time.
        limiter.end('k', { failed: true })
        limiter.end('k', { failed: true })
        limiter.end('k', { failed: false })
        expect(limiter.begin('k')).toBe(0)
        expect(limiter.begin('k')).toBe(1000)

        // That one is wrong too: the allowance is spent, and the block starts.
        limiter.end('k', { failed: true })
        expect(limiter.begin('k')).toBe(1000)
        clock.now += 1000
        // After the block: still one at a time, however many are sent.
        expect(limiter.begin('k')).toBe(0)
        expect(limiter.begin('k')).toBe(1000)
    })

    it('keeps counting what is under way when the failures are cleared', () => {
        const { limiter } = setup({ freeFailures: 2 })
        limiter.begin('k')
        limiter.begin('k')

        limiter.clear('k')

        expect(limiter.begin('k')).toBeGreaterThan(0)
        limiter.end('k', { failed: false })
        limiter.end('k', { failed: false })
        expect(limiter.begin('k')).toBe(0)
    })

    it('never waits longer than the ceiling', () => {
        const { limiter } = setup({ freeFailures: 1, baseDelayMs: 1000, maxDelayMs: 5000 })

        for (let index = 0; index < 30; index++) limiter.fail('k')

        expect(limiter.retryAfter('k')).toBe(5000)
    })

    it('keeps keys apart, clears one on request, and forgets one left alone for long enough', () => {
        const { clock, limiter } = setup({ freeFailures: 1, forgetAfterMs: 10_000 })
        limiter.fail('a')
        limiter.fail('b')
        expect(limiter.retryAfter('c')).toBe(0)

        limiter.clear('a')
        expect(limiter.retryAfter('a')).toBe(0)
        expect(limiter.retryAfter('b')).toBeGreaterThan(0)

        clock.now += 10_001
        limiter.prune()
        expect(limiter.size()).toBe(0)
        // Starts again from nothing: the first failure after that is free of any earlier count.
        limiter.fail('b')
        expect(limiter.retryAfter('b')).toBe(1000)
    })
})

describe('client address', () => {
    const from = (forwardedFor, hops, remoteAddress = '10.0.0.1') => clientAddress({ remoteAddress, forwardedFor }, hops)

    it('ignores the forwarded header entirely unless a proxy is trusted', () => {
        expect(from('203.0.113.9', 0)).toBe('10.0.0.1')
        expect(from('203.0.113.9', undefined)).toBe('10.0.0.1')
        expect(from(undefined, 0, '::ffff:192.0.2.7')).toBe('192.0.2.7')
    })

    it('takes the entry the trusted proxy appended, whatever the client put before it', () => {
        expect(from('198.51.100.4', 1)).toBe('198.51.100.4')
        // The client sent "X-Forwarded-For: 1.1.1.1, 2.2.2.2"; the proxy appended the real address.
        expect(from('1.1.1.1, 2.2.2.2, 198.51.100.4', 1)).toBe('198.51.100.4')
        expect(from(['1.1.1.1', '198.51.100.4'], 1)).toBe('198.51.100.4')
    })

    it('counts back one entry per trusted proxy', () => {
        expect(from('9.9.9.9, 198.51.100.4, 172.16.0.2', 2)).toBe('198.51.100.4')
    })

    it('falls back to the oldest entry it has when there are fewer than expected', () => {
        expect(from(undefined, 1)).toBe('10.0.0.1')
        expect(from('198.51.100.4', 3)).toBe('198.51.100.4')
        expect(from(' , ', 1, '')).toBe('unknown')
    })
})

describe('settings', () => {
    it('default to the public demo’s behaviour', () => {
        const settings = resolveSettings()

        expect(settings).toMatchObject({
            demoBot: false, signupMode: 'open', guests: true, adminUsernames: [], bootstrapCode: null, trustedProxyHops: 0,
            memberDirectory: 'online',
        })
        expect(settings.messageTtlHours).toBeUndefined()
        expect(settingsFromEnv({})).toEqual({
            demoBot: false, guests: true, adminUsernames: [], bootstrapCode: null, signupMode: 'open', proxyCheck: false,
        })
    })

    it('reads the private profile from the environment', () => {
        const warn = vi.fn()

        const settings = settingsFromEnv({
            SIGNUP_MODE: 'invite', GUESTS: 'false', ADMIN_USERNAMES: ' nando , ana ', SIGNUP_BOOTSTRAP_CODE: 'a-code',
            TRUSTED_PROXY_HOPS: '1', MESSAGE_TTL_HOURS: '0', DEMO_BOT: 'false', MEMBER_DIRECTORY: 'all',
        }, warn)

        expect(settings).toEqual({
            demoBot: false, guests: false, adminUsernames: ['nando', 'ana'], bootstrapCode: 'a-code',
            signupMode: 'invite', trustedProxyHops: 1, messageTtlHours: 0, memberDirectory: 'all', proxyCheck: false,
        })
        expect(settingsFromEnv({ PROXY_CHECK: 'true' }).proxyCheck).toBe(true)
        expect(warn).not.toHaveBeenCalled()
    })

    it('warns by name about a value it cannot read, and falls back to the safe side', () => {
        const warn = vi.fn()

        const settings = settingsFromEnv({ SIGNUP_MODE: 'opne', TRUSTED_PROXY_HOPS: 'one', MESSAGE_TTL_HOURS: '-3', MEMBER_DIRECTORY: 'everyone' }, warn)

        // A typo must not open a deployment that was meant to be by invitation.
        expect(settings.signupMode).toBe('closed')
        expect(settings).not.toHaveProperty('trustedProxyHops')
        expect(settings).not.toHaveProperty('messageTtlHours')
        // Listing fewer people is the private side to err on.
        expect(settings).not.toHaveProperty('memberDirectory')
        expect(warn).toHaveBeenCalledTimes(4)
        expect(JSON.stringify(warn.mock.calls)).not.toMatch(/opne|"one"|-3|everyone/)
    })

    it('rejects an unknown sign-up mode passed in code', () => {
        expect(() => resolveSettings({ signupMode: 'maybe' })).toThrow(TypeError)
        expect(() => resolveSettings({ memberDirectory: 'some' })).toThrow(TypeError)
    })
})
