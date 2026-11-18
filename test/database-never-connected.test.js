import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { PASSWORD, ask, getJson, login, onlineUsers, startApp } from './helpers.js'

// Its own file: this process never connects to a database at all, which is the state the
// server is in while it is still retrying its first connection. Mongoose would queue
// commands for 10 s in this state; the handlers must answer straight away instead.
let app

beforeEach(async () => {
    app = await startApp()
})
afterEach(() => app.stop())

const STARTING = { ok: false, message: 'Service is starting, try again', retryable: true }

describe('before the database has ever connected', () => {
    it('refuses every way of logging in at once, as something worth retrying', async () => {
        expect(mongoose.connection.readyState).toBe(0)
        const socket = await app.client()
        const startedAt = Date.now()

        // No name can be checked against the stored ones, so none can be given out.
        expect(await login(socket, { username: 'alice' })).toEqual(STARTING)
        expect(await login(socket, { username: 'alice', password: PASSWORD })).toEqual(STARTING)
        expect(await login(socket, { session: 'a-session-token' })).toEqual(STARTING)
        expect(await ask(socket, 'register', { username: 'alice', password: PASSWORD })).toEqual(STARTING)
        expect(await ask(socket, 'resetPassword', { username: 'alice', recoveryCode: 'x', newPassword: PASSWORD }))
            .toEqual(STARTING)

        expect(Date.now() - startedAt).toBeLessThan(2000)
        expect(await onlineUsers(app)).toEqual([])
    })

    it('still tells a malformed login what is wrong with it', async () => {
        const socket = await app.client()

        expect(await login(socket, { username: 'two words' })).toEqual({ ok: false, message: 'Invalid username' })
    })

    it('still answers the health check with 200, and says the database is down', async () => {
        const response = await getJson(`${app.url}/health`)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ status: 'ok', db: 'down' })
    })
})
