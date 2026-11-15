import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { getHistory, getJson, login, messageTo, onlineUsers, send, startApp } from './helpers.js'

// Its own file: this process never connects to a database at all, which is the state the
// server is in while it is still retrying its first connection. Mongoose would queue
// commands for 10 s in this state; the handlers must answer straight away instead.
let app

beforeEach(async () => {
    app = await startApp()
})
afterEach(() => app.stop())

describe('before the database has ever connected', () => {
    it('fails sends and history requests at once and keeps presence working', async () => {
        expect(mongoose.connection.readyState).toBe(0)
        const alice = await app.client()
        const bob = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })
        const startedAt = Date.now()

        expect(await send(alice, messageTo(bob.id)))
            .toEqual({ ok: false, message: 'Message could not be saved' })
        expect(await getHistory(alice, { withUsername: 'bob' }))
            .toEqual({ ok: false, withUsername: 'bob', message: 'History could not be loaded' })

        expect(Date.now() - startedAt).toBeLessThan(2000)
        expect(await onlineUsers(app)).toHaveLength(2)
    })

    it('still answers the health check with 200, and says the database is down', async () => {
        const response = await getJson(`${app.url}/health`)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ status: 'ok', db: 'down' })
    })
})
