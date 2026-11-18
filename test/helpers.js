import { randomUUID } from 'node:crypto'
import { inject } from 'vitest'
import mongoose from 'mongoose'
import { io as connectSocket } from 'socket.io-client'
import { createApp } from '../src/app.js'
import { connectDB } from '../src/db.js'
import { Identity } from '../src/models/identity.js'
import { Invitation } from '../src/models/invitation.js'
import { Session } from '../src/models/session.js'

// createApp() reads this when called; any value keeps it from warning about a missing allowlist.
process.env.FRONTEND_URL = 'http://localhost:5173'

// Each test file gets its own database inside the shared in-memory MongoDB.
export const testDatabaseUri = () => `${inject('mongoUri').replace(/\/?$/, '/')}test-${randomUUID()}`

export const connectTestDatabase = () => connectDB(testDatabaseUri())

export const disconnectTestDatabase = async () => {
    if (mongoose.connection.readyState === 1) {
        await mongoose.connection.dropDatabase()
    }
    await mongoose.disconnect()
}

// Real password hashing takes ~150 ms and 32 MiB a time: far too slow for a test suite.
export const FAST_PASSWORD_PARAMS = { N: 2 ** 10, r: 8, p: 1 }

// Boots a fresh app instance on an ephemeral port. Presence state lives inside the
// instance, so a new one per test means every test starts with nobody online.
// Names are stored now, so each instance also starts with nobody registered: stopping it
// removes every identity (messages are left to the tests that create them).
export const startApp = async (options = {}) => {
    const { server, io, runMaintenance, hasherStats } = createApp({ passwordParams: FAST_PASSWORD_PARAMS, ...options })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}`
    const clients = []

    // `address` makes the connection look as if a proxy had forwarded it for that client
    // (only believed by an app started with `trustedProxyHops`).
    const client = ({ address } = {}) => new Promise((resolve, reject) => {
        const socket = connectSocket(url, {
            transports: ['websocket'],
            reconnection: false,
            extraHeaders: address ? { 'X-Forwarded-For': address } : {},
        })
        clients.push(socket)
        socket.once('connect', () => resolve(socket))
        socket.once('connect_error', reject)
    })

    const stop = async () => {
        clients.forEach(socket => socket.close())
        await new Promise(resolve => io.close(resolve))
        if (mongoose.connection.readyState === 1) {
            await Promise.all([Identity.deleteMany({}), Session.deleteMany({}), Invitation.deleteMany({})])
        }
    }

    return { url, io, client, stop, runMaintenance, hasherStats }
}

// Resolves with the payload of the next `event`, or rejects if it does not arrive in time.
export const nextEvent = (socket, event, ms = 2000) => new Promise((resolve, reject) => {
    const handler = data => {
        clearTimeout(timer)
        resolve(data)
    }
    const timer = setTimeout(() => {
        socket.off(event, handler)
        reject(new Error(`timed out waiting for "${event}"`))
    }, ms)
    socket.once(event, handler)
})

// Collects every `event` the socket receives from now on. To assert that something was
// NOT sent: start recording, perform the action, wait until the action is known to have
// completed (its reply or its delivery to someone else), then `await settle()` and check
// the recording. Waiting a fixed time from *before* the action is not reliable: a slow
// database write can outlast the wait, and the check would pass without proving anything.
export const record = (socket, event) => {
    const received = []
    socket.on(event, data => received.push(data))
    return received
}

// A short grace period for events that were sent at the same time as one already received.
export const settle = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))

// Emits `event` and resolves with whichever of the two reply events arrives.
const request = (socket, event, payload, successEvent, errorEvent) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to "${event}"`)), 3000)
    const settle = ok => data => {
        clearTimeout(timer)
        socket.off(successEvent, onSuccess)
        socket.off(errorEvent, onError)
        resolve({ ok, ...data })
    }
    const onSuccess = settle(true)
    const onError = settle(false)
    socket.once(successEvent, onSuccess)
    socket.once(errorEvent, onError)
    socket.emit(event, payload)
})

export const login = (socket, payload) => request(socket, 'login', payload, 'loggedin', 'loginError')

// Resolves with the acknowledgement of any event that answers through one.
export const ask = (socket, event, payload = {}) => socket.timeout(3000).emitWithAck(event, payload)

export const PASSWORD = 'correct horse battery'

// Creates an account and resolves with what the server returned: { ok, session, recoveryCode, … }.
export const register = (socket, username, extra = {}) => ask(socket, 'register', { username, password: PASSWORD, ...extra })

export const getHistory = (socket, payload) => request(socket, 'getHistory', payload, 'history', 'historyError')

// Resolves with the acknowledgement the server sends for this message.
export const send = (socket, payload) => socket.timeout(3000).emitWithAck('sendmessage', payload)

export const messageTo = (toUserId, text = 'hello') => ({ toUserId, text, clientId: randomUUID() })

export const getJson = async url => {
    const response = await fetch(url)
    return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: await response.json(),
    }
}

export const onlineUsers = async app => (await getJson(`${app.url}/online-users`)).body.onlineUsers

export const sortedKeys = object => Object.keys(object).sort()
