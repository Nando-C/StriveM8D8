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
        expect(sortedKeys(reply)).toEqual(['id', 'ok', 'onlineUsers', 'sessionToken', 'username'])
        expect(reply.username).toBe('alice')
        expect(reply.id).toBe(alice.id)
        expect(reply.sessionToken).toEqual(expect.any(String))
        expect(reply.onlineUsers).toEqual([{ username: 'alice', id: alice.id }])
        expect(await onlineUsers(app)).toEqual([{ username: 'alice', id: alice.id }])
    })

    it('announces a new user to the others but not to the user themself', async () => {
        const alice = await app.client()
        await login(alice, { username: 'alice' })
        // Connected only after alice's login, so the only announcement it could see is its own.
        const bob = await app.client()

        const announced = nextEvent(alice, 'newLogin')
        const seenByBob = record(bob, 'newLogin')
        const reply = await login(bob, { username: 'bob' })

        expect(await announced).toEqual({ username: 'bob', id: bob.id })
        await settle()
        expect(seenByBob).toEqual([])
        expect(reply.onlineUsers).toEqual([
            { username: 'alice', id: alice.id },
            { username: 'bob', id: bob.id },
        ])
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

    it('never exposes a session token to anyone else', async () => {
        const alice = await app.client()
        const bob = await app.client()
        const aliceSession = await login(alice, { username: 'alice' })

        const announced = nextEvent(alice, 'newLogin')
        const bobSession = await login(bob, { username: 'bob' })

        const seenByOthers = JSON.stringify([await announced, bobSession.onlineUsers, await onlineUsers(app)])
        expect(seenByOthers).not.toContain(aliceSession.sessionToken)
        expect(seenByOthers).not.toContain(bobSession.sessionToken)
        expect(seenByOthers).not.toContain('sessionToken')
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

    it('rejects a username that is already online, with no token or a wrong one', async () => {
        const alice = await app.client()
        const intruder = await app.client()
        await login(alice, { username: 'alice' })

        expect(await login(intruder, { username: 'alice' }))
            .toEqual({ ok: false, message: 'Username already in use' })
        expect(await login(intruder, { username: 'alice', sessionToken: 'not-the-token' }))
            .toEqual({ ok: false, message: 'Username already in use' })
        expect(await onlineUsers(app)).toEqual([{ username: 'alice', id: alice.id }])
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
        expect(await onlineUsers(app)).toContainEqual({ username: 'alice', id: alice.id })
        expect(await onlineUsers(app)).toHaveLength(2)
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
        const announced = nextEvent(bob, 'newLogin')
        const leftSeenByBob = record(bob, 'userLeft')
        const reply = await login(second, { username: 'alice', sessionToken: firstSession.sessionToken })

        expect(reply.ok).toBe(true)
        expect(reply.id).toBe(second.id)
        expect(reply.sessionToken).not.toBe(firstSession.sessionToken)
        expect(await kicked).toBe('io server disconnect')
        expect(await announced).toEqual({ username: 'alice', id: second.id })

        const users = await onlineUsers(app)
        expect(users.filter(user => user.username === 'alice')).toEqual([{ username: 'alice', id: second.id }])
        expect(users).toHaveLength(2)
        // Alice has not left: she is online under a new id, so nobody is told she went away.
        await settle()
        expect(leftSeenByBob).toEqual([])
    })

    it('does not accept the old token once it has been replaced', async () => {
        const first = await app.client()
        const firstSession = await login(first, { username: 'alice' })
        const second = await app.client()
        await login(second, { username: 'alice', sessionToken: firstSession.sessionToken })

        const third = await app.client()
        const reply = await login(third, { username: 'alice', sessionToken: firstSession.sessionToken })

        expect(reply).toEqual({ ok: false, message: 'Username already in use' })
    })
})

describe('disconnect', () => {
    it('tells the other clients which user left', async () => {
        const alice = await app.client()
        const bob = await app.client()
        const carol = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })
        await login(carol, { username: 'carol' })
        const aliceId = alice.id

        const toldBob = nextEvent(bob, 'userLeft')
        const toldCarol = nextEvent(carol, 'userLeft')
        alice.close()

        expect(await toldBob).toEqual({ id: aliceId })
        expect(await toldCarol).toEqual({ id: aliceId })
    })

    it('says nothing when a socket that never logged in disconnects', async () => {
        const alice = await app.client()
        const visitor = await app.client()
        const lurker = await app.client()
        await login(alice, { username: 'alice' })
        await login(visitor, { username: 'visitor' })
        const leftSeenByAlice = record(alice, 'userLeft')

        lurker.close()
        // A logged-in user leaving afterwards is the signal that the server has
        // processed the earlier disconnect too: only this one may be announced.
        const visitorId = visitor.id
        const toldAlice = nextEvent(alice, 'userLeft')
        visitor.close()
        await toldAlice
        await settle()

        expect(leftSeenByAlice).toEqual([{ id: visitorId }])
    })

    it('removes the user from the online list and frees the username', async () => {
        const alice = await app.client()
        const bob = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })

        alice.close()

        await expect.poll(() => onlineUsers(app)).toEqual([{ username: 'bob', id: bob.id }])
        const newcomer = await app.client()
        expect((await login(newcomer, { username: 'alice' })).ok).toBe(true)
    })
})

describe('REST', () => {
    it('serves /online-users as { username, id } entries only', async () => {
        const alice = await app.client()
        await login(alice, { username: 'alice' })

        const response = await getJson(`${app.url}/online-users`)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ onlineUsers: [{ username: 'alice', id: alice.id }] })
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
