import net from 'node:net'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { connectDB } from '../src/db.js'

// Its own file: it needs this process's database connection to start out unconnected,
// and it starts a database of its own on a port that was closed a moment earlier.
let lateDatabase

const freePort = () => new Promise(resolve => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address()
        probe.close(() => resolve(port))
    })
})

afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
    await mongoose.disconnect()
    await lateDatabase?.stop()
})

describe('connectDB', () => {
    it('resolves without connecting when no connection string is given', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        await expect(connectDB(undefined)).resolves.toBeUndefined()

        expect(warn).toHaveBeenCalledOnce()
        expect(mongoose.connection.readyState).toBe(0)
    })

    it('keeps retrying while the database is unreachable and connects once it appears', async () => {
        const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const port = await freePort()
        let settled = false

        const connecting = connectDB(`mongodb://127.0.0.1:${port}/retry-test`, {
            serverSelectionTimeoutMS: 300,
            retryDelayMs: 100,
            maxRetryDelayMs: 200,
        }).then(() => {
            settled = true
        })

        await vi.waitFor(() => expect(failures.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 8000 })
        expect(settled).toBe(false)
        // Only the error name is logged, never the connection string.
        expect(failures.mock.calls.flat().join(' ')).not.toContain('mongodb://')

        lateDatabase = await MongoMemoryServer.create({ instance: { port } })
        await connecting

        expect(settled).toBe(true)
        expect(mongoose.connection.readyState).toBe(1)
    }, 60000)
})
