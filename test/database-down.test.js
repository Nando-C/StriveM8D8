import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { connectDB } from '../src/db.js'
import {
    PASSWORD, ask, disconnectTestDatabase, getHistory, login, messageTo, nextEvent, onlineUsers, send, startApp,
    testDatabaseUri,
} from './helpers.js'

// Its own file: it disconnects this process's database connection on purpose.
const STARTING = { ok: false, message: 'Service is starting, try again', retryable: true }

let app
const uri = testDatabaseUri()

beforeAll(() => connectDB(uri))
afterAll(disconnectTestDatabase)
beforeEach(async () => {
    app = await startApp()
})
afterEach(() => app.stop())

describe('with the database unavailable', () => {
    it('fails sends and history requests at once, stays up, and recovers', async () => {
        const alice = await app.client()
        const bob = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })

        await mongoose.disconnect()
        const startedAt = Date.now()

        expect(await send(alice, messageTo(bob.id)))
            .toEqual({ ok: false, message: 'Message could not be saved' })
        expect(await getHistory(alice, { withUsername: 'bob' }))
            .toEqual({ ok: false, withUsername: 'bob', message: 'History could not be loaded' })
        // Far below Mongoose's 10 s command-buffering timeout: the handlers fail fast.
        expect(Date.now() - startedAt).toBeLessThan(2000)
        // Whoever is logged in stays; nobody new can be checked, so nobody new gets in.
        expect(await onlineUsers(app)).toHaveLength(2)
        const carol = await app.client()
        expect(await login(carol, { username: 'carol' })).toEqual(STARTING)
        expect(await ask(carol, 'register', { username: 'carol', password: PASSWORD }))
            .toEqual(STARTING)

        await connectDB(uri)

        expect((await login(carol, { username: 'carol' })).ok).toBe(true)

        const delivered = nextEvent(bob, 'message')
        expect((await send(alice, messageTo(bob.id, 'back again'))).ok).toBe(true)
        expect((await delivered).text).toBe('back again')
        const history = await getHistory(alice, { withUsername: 'bob' })
        expect(history.messages.map(message => message.text)).toEqual(['back again'])
    })
})
