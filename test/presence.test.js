import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    connectTestDatabase, disconnectTestDatabase, getJson, login, nextEvent, onlineUsers, record,
    settle, sortedKeys, startApp,
} from './helpers.js'

let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
beforeEach(async () => {
    app = await startApp()
})
afterEach(() => app.stop())

describe('login', () => {
    it('lists the user and returns the session with the current online list', async () => {
        const alice = await app.client()

        const reply = await login(alice, { username: '  alice ' })

        expect(reply.ok).toBe(true)
        expect(sortedKeys(reply)).toEqual([
            'admin', 'conversations', 'groupIds', 'kind', 'ok', 'onlineUsers', 'ownStatus', 'reservation', 'sessionToken', 'userId', 'username',
        ])
        expect(reply.kind).toBe('guest')
        expect(reply.admin).toBe(false)
        expect(reply.reservation).toEqual(expect.any(String))
        expect(reply.username).toBe('alice')
        expect(reply.userId).toMatch(/^[0-9a-f-]{36}$/)
        expect(reply.sessionToken).toEqual(expect.any(String))
        expect(reply.conversations).toEqual([])
        expect(reply.onlineUsers).toEqual([{ userId: reply.userId, username: 'alice', kind: 'guest', status: 'online', statusText: '' }])
        expect(await onlineUsers(app)).toEqual(reply.onlineUsers)
        // Nothing about a user says which connection they are on.
        expect(JSON.stringify([reply, await onlineUsers(app)])).not.toContain(alice.id)
    })

    it('announces a new user to the others but not to the user themself', async () => {
        const alice = await app.client()
        const aliceSession = await login(alice, { username: 'alice' })
        // Connected only after alice's login, so the only announcement it could see is its own.
        const bob = await app.client()

        const announced = nextEvent(alice, 'newLogin')
        const seenByBob = record(bob, 'newLogin')
        const reply = await login(bob, { username: 'bob' })

        expect(await announced).toEqual({ userId: reply.userId, username: 'bob', kind: 'guest', status: 'online', statusText: '' })
        await settle()
        expect(seenByBob).toEqual([])
        expect(reply.onlineUsers).toEqual([
            { userId: aliceSession.userId, username: 'alice', kind: 'guest', status: 'online', statusText: '' },
            { userId: reply.userId, username: 'bob', kind: 'guest', status: 'online', statusText: '' },
        ])
        expect(JSON.stringify([await announced, reply.onlineUsers])).not.toContain(bob.id)
    })

    it('does not duplicate or re-announce a repeat login from the same socket', async () => {
        const alice = await app.client()
        const bob = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })

        const seenByBob = record(bob, 'newLogin')
        const again = await login(alice, { username: 'alice' })

        expect(again.ok).toBe(true)
        await settle()
        expect(seenByBob).toEqual([])
        expect(await onlineUsers(app)).toHaveLength(2)
    })

    it('never exposes a session token or a reservation to anyone else', async () => {
        const alice = await app.client()
        const bob = await app.client()
        const aliceSession = await login(alice, { username: 'alice' })

        const announced = nextEvent(alice, 'newLogin')
        const bobSession = await login(bob, { username: 'bob' })

        const seenByOthers = JSON.stringify([await announced, bobSession.onlineUsers, await onlineUsers(app)])
        expect(seenByOthers).not.toContain(aliceSession.sessionToken)
        expect(seenByOthers).not.toContain(bobSession.sessionToken)
        expect(seenByOthers).not.toContain('sessionToken')
        expect(seenByOthers).not.toContain(aliceSession.reservation)
        expect(seenByOthers).not.toContain('reservation')
    })

    it.each([
        ['contains the key separator', 'a::b'],
        ['contains whitespace', 'two words'],
        ['is empty', '   '],
        ['is too long', 'x'.repeat(31)],
    ])('rejects a username that %s', async (_label, username) => {
        const socket = await app.client()

        const reply = await login(socket, { username })

        expect(reply).toEqual({ ok: false, message: 'Invalid username' })
        expect(await onlineUsers(app)).toEqual([])
    })

    it('rejects a guest name that is taken, with no reservation, a wrong one, or the connection token', async () => {
        const alice = await app.client()
        const intruder = await app.client()
        const aliceSession = await login(alice, { username: 'alice' })

        expect(await login(intruder, { username: 'alice' }))
            .toEqual({ ok: false, message: 'Username already in use' })
        expect(await login(intruder, { username: 'alice', reservation: 'not-the-secret' }))
            .toEqual({ ok: false, message: 'Username already in use' })
        // The per-connection token says which old connection to replace; it proves nothing.
        expect(await login(intruder, { username: 'alice', sessionToken: aliceSession.sessionToken }))
            .toEqual({ ok: false, message: 'Username already in use' })
        expect((await onlineUsers(app)).map(user => user.userId)).toEqual([aliceSession.userId])
    })

    it('does not let a logged-in socket switch to another username', async () => {
        const alice = await app.client()
        const bob = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })

        const seenByBob = record(bob, 'newLogin')
        const reply = await login(alice, { username: 'zed' })

        expect(reply).toEqual({ ok: false, message: 'Already logged in' })
        await settle()
        expect(seenByBob).toEqual([])
        expect((await onlineUsers(app)).map(user => user.username)).toEqual(['alice', 'bob'])
    })
})

describe('a connection that has not logged in', () => {
    it('is told nothing about who is here: not arrivals, not departures, not changes', async () => {
        const lurker = await app.client()
        const seen = []
        lurker.onAny((event, payload) => seen.push([event, payload]))
        const alice = await app.client()
        await login(alice, { username: 'alice' })
        const bob = await app.client()
        const { userId: bobId } = await login(bob, { username: 'bob' })

        // Everything that is announced: a guest becoming an account, and someone leaving.
        const relisted = nextEvent(alice, 'newLogin')
        await bob.timeout(3000).emitWithAck('register', { username: 'bob', password: 'a long password' })
        expect(await relisted).toEqual({ userId: bobId, username: 'bob', kind: 'account', status: 'online', statusText: '' })
        const left = nextEvent(alice, 'userLeft')
        bob.close()
        await left
        await settle()

        expect(seen).toEqual([])
    })

    it('is told from the moment it logs in, and no longer once it has logged out', async () => {
        const alice = await app.client()
        await login(alice, { username: 'alice' })
        const seen = record(alice, 'newLogin')
        await alice.timeout(3000).emitWithAck('logout', {})

        const bob = await app.client()
        await login(bob, { username: 'bob' })
        const carol = await app.client()
        const told = nextEvent(bob, 'newLogin')
        await login(carol, { username: 'carol' })
        await told
        await settle()

        expect(seen).toEqual([])
    })
})

describe('session takeover', () => {
    it('lets the same user reclaim their name from a still-connected socket', async () => {
        const first = await app.client()
        const bob = await app.client()
        const firstSession = await login(first, { username: 'alice' })
        await login(bob, { username: 'bob' })

        const second = await app.client()
        const kicked = nextEvent(first, 'disconnect')
        const joinsSeenByBob = record(bob, 'newLogin')
        const leftSeenByBob = record(bob, 'userLeft')
        const reply = await login(second, { username: 'alice', reservation: firstSession.reservation })

        expect(reply.ok).toBe(true)
        // The secret is handed over once, when the name is first reserved.
        expect(reply).not.toHaveProperty('reservation')
        expect(reply.userId).toBe(firstSession.userId)
        expect(reply.sessionToken).not.toBe(firstSession.sessionToken)
        expect(await kicked).toBe('io server disconnect')

        const users = await onlineUsers(app)
        expect(users.filter(user => user.username === 'alice')).toHaveLength(1)
        expect(users).toHaveLength(2)
        // Alice never stopped being online as far as anyone else can tell: she is the
        // same user on another connection, so nothing is announced either way.
        await settle()
        expect(leftSeenByBob).toEqual([])
        expect(joinsSeenByBob).toEqual([])
    })

    it('keeps a guest to one connection: each new one replaces the last', async () => {
        const first = await app.client()
        const { reservation } = await login(first, { username: 'alice' })
        const second = await app.client()
        await login(second, { username: 'alice', reservation })

        const third = await app.client()
        const kicked = nextEvent(second, 'disconnect')
        const reply = await login(third, { username: 'alice', reservation })

        expect(reply.ok).toBe(true)
        expect(await kicked).toBe('io server disconnect')
        expect((await onlineUsers(app)).map(user => user.username)).toEqual(['alice'])
        expect(app.io.sockets.sockets.has(third.id)).toBe(true)
    })
})

describe('disconnect', () => {
    it('tells the other clients which user left', async () => {
        const alice = await app.client()
        const bob = await app.client()
        const carol = await app.client()
        const { userId } = await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })
        await login(carol, { username: 'carol' })

        const toldBob = nextEvent(bob, 'userLeft')
        const toldCarol = nextEvent(carol, 'userLeft')
        alice.close()

        expect(await toldBob).toEqual({ userId })
        expect(await toldCarol).toEqual({ userId })
    })

    it('says nothing when a socket that never logged in disconnects', async () => {
        const alice = await app.client()
        const visitor = await app.client()
        const lurker = await app.client()
        await login(alice, { username: 'alice' })
        const { userId: visitorId } = await login(visitor, { username: 'visitor' })
        const leftSeenByAlice = record(alice, 'userLeft')

        lurker.close()
        // A logged-in user leaving afterwards is the signal that the server has
        // processed the earlier disconnect too: only this one may be announced.
        const toldAlice = nextEvent(alice, 'userLeft')
        visitor.close()
        await toldAlice
        await settle()

        expect(leftSeenByAlice).toEqual([{ userId: visitorId }])
    })

    it('removes the user from the online list, and keeps the name for them', async () => {
        const alice = await app.client()
        const bob = await app.client()
        const { reservation } = await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })

        alice.close()

        await expect.poll(async () => (await onlineUsers(app)).map(user => user.username)).toEqual(['bob'])
        const newcomer = await app.client()
        expect(await login(newcomer, { username: 'alice' }))
            .toEqual({ ok: false, message: 'Username already in use' })
        expect((await login(newcomer, { username: 'alice', reservation })).ok).toBe(true)
    })
})

describe('REST', () => {
    it('serves /online-users as { userId, username, kind } entries only', async () => {
        const alice = await app.client()
        const { userId } = await login(alice, { username: 'alice' })

        const response = await getJson(`${app.url}/online-users`)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ onlineUsers: [{ userId, username: 'alice', kind: 'guest', status: 'online', statusText: '' }] })
    })

    it('reports itself healthy, with the database up', async () => {
        const response = await getJson(`${app.url}/health`)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ status: 'ok', db: 'up' })
    })

    it('answers an unknown route with 404 JSON', async () => {
        const response = await getJson(`${app.url}/nope`)

        expect(response.status).toBe(404)
        expect(response.contentType).toMatch(/json/)
        expect(response.body).toEqual({ message: 'Not Found' })
    })
})

describe('protocol version', () => {
    it('refuses a client built for another version, with a reason it can act on', async () => {
        for (const protocol of [1, 3, '2', null]) {
            const error = await app.client({ protocol }).then(() => null, refusal => refusal)

            expect(error).not.toBeNull()
            expect(error.message).toBe('Unsupported protocol version')
            expect(error.data).toEqual({ code: 'protocol', protocol: 2 })
        }
        expect(app.io.sockets.sockets.size).toBe(0)
    })

    it('says which version it speaks before anyone connects', async () => {
        expect((await getJson(`${app.url}/config`)).body.protocol).toBe(2)
    })
})
