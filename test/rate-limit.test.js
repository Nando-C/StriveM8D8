import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Message } from '../src/models/message.js'
import { createRateLimiter } from '../src/rateLimit.js'
import {
    connectTestDatabase, disconnectTestDatabase, getHistory, login, messageTo, nextEvent, onlineUsers,
    record, send, settle, startApp,
} from './helpers.js'

let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
beforeEach(async () => {
    app = await startApp({ demoBot: true })
})
afterEach(async () => {
    await app.stop()
    await Message.deleteMany({})
})

const SLOW_DOWN = 'Too many requests, slow down'

describe('rate limits', () => {
    it('refuses the 11th message in a burst, saves and delivers only the first ten', async () => {
        const alice = await app.client()
        const bob = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })
        const delivered = record(bob, 'message')

        const acks = []
        for (let index = 1; index <= 12; index++) acks.push(await send(alice, messageTo(bob.id, `message ${index}`)))

        expect(acks.slice(0, 10).every(ack => ack.ok)).toBe(true)
        expect(acks.slice(10)).toEqual([
            { ok: false, message: SLOW_DOWN },
            { ok: false, message: SLOW_DOWN },
        ])
        await settle()
        expect(delivered).toHaveLength(10)
        expect(await Message.countDocuments()).toBe(10)
    })

    it('counts each socket separately', async () => {
        const alice = await app.client()
        const bob = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })
        for (let index = 0; index < 11; index++) await send(alice, messageTo(bob.id))

        expect((await send(bob, messageTo(alice.id))).ok).toBe(true)
    })

    it('counts invalid messages too, and messages to the bot', async () => {
        const alice = await app.client()
        await login(alice, { username: 'alice' })

        for (let index = 0; index < 5; index++) await send(alice, { nonsense: true })
        for (let index = 0; index < 5; index++) await send(alice, messageTo('demo-bot'))

        expect(await send(alice, messageTo('demo-bot'))).toEqual({ ok: false, message: SLOW_DOWN })
    })

    it('refuses the 6th login in a burst without telling anyone else', async () => {
        const watcher = await app.client()
        await login(watcher, { username: 'watcher' })
        const hammer = await app.client()
        const announced = record(watcher, 'newLogin')

        const replies = []
        for (let index = 0; index < 7; index++) replies.push(await login(hammer, { username: 'hammer' }))

        expect(replies.slice(0, 5).every(reply => reply.ok)).toBe(true)
        expect(replies.slice(5)).toEqual([
            { ok: false, message: SLOW_DOWN },
            { ok: false, message: SLOW_DOWN },
        ])
        await settle()
        // Announced once, for the first login; the repeats and the refusals are silent.
        expect(announced).toEqual([{ username: 'hammer', id: hammer.id }])
        expect(await onlineUsers(app)).toHaveLength(3)
    })

    it('refuses the 11th history request in a burst', async () => {
        const alice = await app.client()
        await login(alice, { username: 'alice' })

        const replies = []
        for (let index = 0; index < 11; index++) replies.push(await getHistory(alice, { withUsername: 'bob' }))

        expect(replies.slice(0, 10).every(reply => reply.ok)).toBe(true)
        expect(replies[10]).toEqual({ ok: false, withUsername: 'bob', message: SLOW_DOWN })
    })

    it('does not carry a limit over to a new connection', async () => {
        const first = await app.client()
        for (let index = 0; index < 6; index++) await login(first, { username: 'alice' })
        first.close()
        await expect.poll(async () => (await onlineUsers(app)).length).toBe(1)

        const second = await app.client()
        expect((await login(second, { username: 'alice' })).ok).toBe(true)
    })
})

describe('payload size cap', () => {
    it('accepts the largest legitimate message, even made of 4-byte characters', async () => {
        const alice = await app.client()
        const bob = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })

        const ack = await send(alice, messageTo(bob.id, '🙂'.repeat(1000))) // 2000 UTF-16 units, 4 kB

        expect(ack.ok).toBe(true)
    })

    it('drops a connection that sends far more than any message needs', async () => {
        const alice = await app.client()
        await login(alice, { username: 'alice' })
        const closed = nextEvent(alice, 'disconnect')

        alice.emit('sendmessage', messageTo('anyone', 'x'.repeat(50_000)))

        await closed
        expect(await Message.countDocuments()).toBe(0)
        await expect.poll(async () => (await onlineUsers(app)).map(user => user.username)).toEqual(['demo-bot'])
    })
})

describe('the limiter itself', () => {
    it('lets calls through again once they fall out of the window', () => {
        let now = 1_000
        const limiter = createRateLimiter(() => now)
        const rule = { limit: 2, windowMs: 1_000 }

        expect(limiter.allow('a', 'send', rule)).toBe(true)
        now += 400
        expect(limiter.allow('a', 'send', rule)).toBe(true)
        expect(limiter.allow('a', 'send', rule)).toBe(false)

        now += 601 // the first call is now more than a second old
        expect(limiter.allow('a', 'send', rule)).toBe(true)
        expect(limiter.allow('a', 'send', rule)).toBe(false)
    })

    it('does not let refused calls extend the wait', () => {
        let now = 0
        const limiter = createRateLimiter(() => now)
        const rule = { limit: 1, windowMs: 1_000 }
        limiter.allow('a', 'send', rule)

        for (now = 100; now <= 900; now += 100) expect(limiter.allow('a', 'send', rule)).toBe(false)

        now = 1_001
        expect(limiter.allow('a', 'send', rule)).toBe(true)
    })

    it('keeps owners and keys apart, and forgets on request', () => {
        const limiter = createRateLimiter(() => 0)
        const rule = { limit: 1, windowMs: 1_000 }

        expect(limiter.allow('a', 'send', rule)).toBe(true)
        expect(limiter.allow('a', 'login', rule)).toBe(true)
        expect(limiter.allow('b', 'send', rule)).toBe(true)
        expect(limiter.allow('a', 'send', rule)).toBe(false)

        limiter.forget('a')
        expect(limiter.allow('a', 'send', rule)).toBe(true)
    })
})
