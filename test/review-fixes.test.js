import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Conversation } from '../src/models/conversation.js'
import { Identity, backfillUsernameKeys } from '../src/models/identity.js'
import { Session } from '../src/models/session.js'
import { createRateLimiter } from '../src/rateLimit.js'
import {
    PASSWORD, ask, connectTestDatabase, disconnectTestDatabase, join, login, nextEvent, onlineUsers, register,
    settle, startApp,
} from './helpers.js'

// Behaviour pinned down after a review of the accounts code: each case here was a way
// for something to be guessed, lost or left half-done.
let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
afterEach(async () => {
    vi.restoreAllMocks()
    await app.stop()
})

const BOOTSTRAP = 'the-owners-bootstrap-code'
const OWNED = { adminUsernames: ['owner'], bootstrapCode: BOOTSTRAP }

describe('the bootstrap code', () => {
    it('cannot be guessed at speed: a burst of guesses is cut off like guesses at a password', async () => {
        app = await startApp(OWNED)
        const sockets = await Promise.all(Array.from({ length: 30 }, () => app.client()))

        const answers = await Promise.all(sockets.map((socket, index) =>
            register(socket, 'owner', { bootstrapCode: `guess-${index}` })))

        expect(answers.filter(answer => answer.message === 'That name is reserved')).toHaveLength(5)
        const turnedAway = answers.filter(answer => answer.message?.startsWith('Too many attempts'))
        expect(turnedAway).toHaveLength(25)
        expect(turnedAway.every(answer => answer.retryAfterMs > 0)).toBe(true)
        // The right code does not get in on the back of the burst either.
        expect((await register(await app.client(), 'owner', { bootstrapCode: BOOTSTRAP })).ok).toBe(false)
        expect(await Identity.countDocuments()).toBe(0)
    })

    it('still works first time for the owner, and offering none is not counted as a guess', async () => {
        app = await startApp(OWNED)
        for (let index = 0; index < 8; index++) {
            expect(await register(await app.client(), 'owner')).toEqual({ ok: false, message: 'That name is reserved' })
        }

        expect(await register(await app.client(), 'owner', { bootstrapCode: BOOTSTRAP })).toMatchObject({ ok: true, admin: true })
    })
})

describe('a name, whatever its case', () => {
    it('is one name: nobody can take a variant of somebody else’s', async () => {
        app = await startApp()
        const alice = await join(app, 'Alice')
        await register(await app.client(), 'Bob')
        const other = await app.client()

        for (const variant of ['alice', 'ALICE', 'aLiCe']) {
            expect(await login(other, { username: variant })).toEqual({ ok: false, message: 'Username already in use' })
            expect(await register(await app.client(), variant)).toEqual({ ok: false, message: 'Username already in use' })
        }
        expect(await login(await app.client(), { username: 'bob' }))
            .toEqual({ ok: false, message: 'That name belongs to an account — sign in' })
        expect(await register(await app.client(), 'BOB')).toEqual({ ok: false, message: 'Username already in use' })
        expect(await Identity.countDocuments()).toBe(2)
        expect(alice.username).toBe('Alice')
    })

    it('keeps the spelling its owner chose, however they type it to get back in', async () => {
        app = await startApp()
        const first = await join(app, 'Alice')
        first.socket.close()
        await expect.poll(() => onlineUsers(app)).toEqual([])
        await register(await app.client(), 'Bob')

        const guest = await login(await app.client(), { username: 'alice', reservation: first.reservation })
        const account = await login(await app.client(), { username: 'BOB', password: PASSWORD })

        expect(guest).toMatchObject({ ok: true, username: 'Alice', userId: first.userId })
        expect(account).toMatchObject({ ok: true, username: 'Bob' })
        expect((await onlineUsers(app)).map(user => user.username).sort()).toEqual(['Alice', 'Bob'])
    })

    it('covers the reserved names: the bot’s and the administrators’', async () => {
        app = await startApp({ ...OWNED, demoBot: true })
        const socket = await app.client()

        for (const variant of ['Demo-Bot', 'DEMO-BOT']) {
            expect(await login(socket, { username: variant })).toEqual({ ok: false, message: 'Username already in use' })
            expect(await register(await app.client(), variant)).toEqual({ ok: false, message: 'Username already in use' })
        }
        for (const variant of ['Owner', 'OWNER']) {
            expect(await login(await app.client(), { username: variant })).toEqual({ ok: false, message: 'That name is reserved' })
            expect(await register(await app.client(), variant)).toEqual({ ok: false, message: 'That name is reserved' })
        }
        // The owner may spell their own name as they like.
        expect(await register(await app.client(), 'Owner', { bootstrapCode: BOOTSTRAP })).toMatchObject({ ok: true, admin: true })
    })

    it('lets a guest turn their own name into an account however they type it', async () => {
        app = await startApp()
        const alice = await join(app, 'Alice')

        expect(await register(alice.socket, 'alice')).toMatchObject({ ok: true, kind: 'account' })
        expect((await Identity.findOne({ userId: alice.userId }).lean())).toMatchObject({ username: 'Alice', kind: 'account' })
    })

    it('gives identities stored before this a key, and settles old clashes in favour of the older', async () => {
        app = await startApp()
        const old = (username, createdAt) => ({ userId: randomUUID(), username, kind: 'guest', secretHash: 'x', createdAt })
        await Identity.collection.insertMany([
            old('Carol', new Date(2026, 0, 1)), old('carol', new Date(2026, 0, 2)), old('dave', new Date(2026, 0, 3)),
        ])
        expect(await Identity.countDocuments({ usernameKey: { $exists: true } })).toBe(0)

        expect(await backfillUsernameKeys()).toBe(1)

        const keyed = await Identity.find({ usernameKey: { $exists: true } }).lean()
        expect(keyed.map(identity => [identity.username, identity.usernameKey]).sort()).toEqual([['Carol', 'carol'], ['dave', 'dave']])
        // Harmless to run again.
        expect(await backfillUsernameKeys()).toBe(1)
    })
})

describe('creating an account', () => {
    it('leaves nothing behind when its device session cannot be stored: the name is free to try again', async () => {
        app = await startApp()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(Session, 'create').mockImplementationOnce(() => {
            throw Object.assign(new Error('down'), { name: 'MongoNetworkError' })
        })
        const socket = await app.client()

        expect(await register(socket, 'alice')).toMatchObject({ ok: false, retryable: true })
        expect(await Identity.countDocuments()).toBe(0)
        expect(await Session.countDocuments()).toBe(0)

        // No account exists whose recovery code nobody was shown.
        const again = await register(socket, 'alice')
        expect(again).toMatchObject({ ok: true, recoveryCode: expect.any(String) })
    })

    it('takes its device session back when the account itself cannot be stored', async () => {
        app = await startApp()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(Identity, 'create').mockImplementationOnce(() => {
            throw Object.assign(new Error('down'), { name: 'MongoNetworkError' })
        })

        expect(await register(await app.client(), 'alice')).toMatchObject({ ok: false, retryable: true })

        expect(await Session.countDocuments()).toBe(0)
        expect(await Identity.countDocuments()).toBe(0)
    })

    it('leaves a guest a guest when turning them into an account fails part-way', async () => {
        app = await startApp()
        const alice = await join(app, 'alice')
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(Session, 'create').mockImplementationOnce(() => {
            throw Object.assign(new Error('down'), { name: 'MongoNetworkError' })
        })

        expect((await register(alice.socket, 'alice')).ok).toBe(false)

        expect((await Identity.findOne({ userId: alice.userId }).lean()).kind).toBe('guest')
        expect((await onlineUsers(app))[0].kind).toBe('guest')
        // Their reservation still gets them back in.
        expect((await login(await app.client(), { username: 'alice', reservation: alice.reservation })).ok).toBe(true)
    })

    it('does not fail because old device sessions could not be tidied away', async () => {
        app = await startApp()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(Session, 'find').mockImplementationOnce(() => {
            throw Object.assign(new Error('down'), { name: 'MongoNetworkError' })
        })

        expect((await register(await app.client(), 'alice')).ok).toBe(true)
    })
})

describe('a device session that was never handed over', () => {
    it('is removed when the login cannot be completed, instead of showing as a device', async () => {
        app = await startApp()
        const owner = await app.client()
        const account = await register(owner, 'alice')
        await login(owner, { session: account.session })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        // The password is right and a session is made; gathering the rest of the login then fails.
        vi.spyOn(Conversation, 'find').mockImplementationOnce(() => {
            throw Object.assign(new Error('down'), { name: 'MongoNetworkError' })
        })

        expect((await login(await app.client(), { username: 'alice', password: PASSWORD })).ok).toBe(false)

        expect((await ask(owner, 'listSessions')).sessions).toHaveLength(1)
        expect(await Session.countDocuments()).toBe(1)
    })
})

describe('a new guest name whose secret never arrived', () => {
    it('is given up if the browser does not confirm it in time', async () => {
        app = await startApp({ reservationAckTimeoutMs: 100 })
        const socket = await app.client()
        // A client that receives `loggedin` and never acknowledges it — as when the packet is lost.
        const received = nextEvent(socket, 'loggedin')
        const told = nextEvent(socket, 'sessionRevoked')
        socket.emit('login', { username: 'alice' })
        expect((await received).reservation).toEqual(expect.any(String))

        expect(await told).toEqual({ reason: 'The login could not be completed — try again' })
        await expect.poll(() => Identity.countDocuments({ username: 'alice' })).toBe(0)
        expect(await onlineUsers(app)).toEqual([])
        // The name is not lost to anybody: it can simply be taken again.
        expect((await login(await app.client(), { username: 'alice' })).ok).toBe(true)
    })

    it('is given up at once if the connection closes before it is confirmed', async () => {
        app = await startApp()
        const socket = await app.client()
        const received = nextEvent(socket, 'loggedin')
        socket.emit('login', { username: 'alice' })
        await received

        socket.close()

        await expect.poll(() => Identity.countDocuments({ username: 'alice' })).toBe(0)
    })

    it('is kept once confirmed, and for a returning guest nothing needs confirming', async () => {
        app = await startApp({ reservationAckTimeoutMs: 100 })
        const alice = await join(app, 'alice')
        await settle(300)
        expect(await Identity.countDocuments({ username: 'alice' })).toBe(1)

        // Back on a new connection, with a client that acknowledges nothing: still theirs.
        const again = await app.client()
        const received = nextEvent(again, 'loggedin')
        again.emit('login', { username: 'alice', reservation: alice.reservation })
        await received
        await settle(300)

        expect(await Identity.countDocuments({ username: 'alice' })).toBe(1)
        expect((await onlineUsers(app)).map(user => user.username)).toEqual(['alice'])
    })
})

describe('a guest who becomes an account where every account is listed', () => {
    it('is given the list there and then', async () => {
        app = await startApp({ memberDirectory: 'all' })
        await register(await app.client(), 'bea')
        const alice = await join(app, 'alice')
        expect(alice).not.toHaveProperty('members')

        const listed = nextEvent(alice.socket, 'memberDirectory')
        expect((await register(alice.socket, 'alice')).ok).toBe(true)

        expect((await listed).members.map(member => member.username)).toEqual(['alice', 'bea'])
    })

    it('is sent nothing of the kind where there is no directory', async () => {
        app = await startApp()
        const alice = await join(app, 'alice')
        const seen = []
        alice.socket.onAny(event => seen.push(event))

        await register(alice.socket, 'alice')
        await settle()

        expect(seen).not.toContain('memberDirectory')
    })
})

describe('what is remembered about client addresses', () => {
    it('is dropped once it can no longer matter', () => {
        let now = 0
        const limiter = createRateLimiter(() => now)
        const rule = { limit: 5, windowMs: 3_600_000 }
        limiter.allow('address:198.51.100.1', 'newGuests', rule)
        now += 30 * 60_000
        limiter.allow('address:198.51.100.2', 'newGuests', rule)
        expect(limiter.owners()).toBe(2)

        now += 31 * 60_000
        limiter.prune(3_600_000)
        // The first has made no call for over an hour; the second has.
        expect(limiter.owners()).toBe(1)

        now += 3_600_000
        limiter.prune(3_600_000)
        expect(limiter.owners()).toBe(0)
        // And a pruned address simply starts again.
        expect(limiter.allow('address:198.51.100.1', 'newGuests', rule)).toBe(true)
    })
})
