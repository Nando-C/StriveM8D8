import { afterEach, describe, expect, it, vi } from 'vitest'
import { io as connectSocket } from 'socket.io-client'
import { startApp } from './helpers.js'

// No database needed: the origin allowlist is applied before any handler runs.
let app
const originalFrontendUrl = process.env.FRONTEND_URL

const startWith = async frontendUrl => {
    process.env.FRONTEND_URL = frontendUrl
    app = await startApp()
}

const corsHeaderFor = async origin => {
    const response = await fetch(`${app.url}/online-users`, { headers: { Origin: origin } })
    return response.headers.get('access-control-allow-origin')
}

const canConnectFrom = origin => new Promise(resolve => {
    const socket = connectSocket(app.url, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: origin ? { Origin: origin } : {},
    })
    socket.once('connect', () => {
        socket.close()
        resolve(true)
    })
    socket.once('connect_error', () => resolve(false))
})

afterEach(async () => {
    process.env.FRONTEND_URL = originalFrontendUrl
    vi.restoreAllMocks()
    await app.stop()
})

describe('origin allowlist', () => {
    it('admits listed origins and non-browser clients, and refuses everything else', async () => {
        await startWith('http://localhost:5173, https://chat.example.com')

        expect(await corsHeaderFor('http://localhost:5173')).toBe('http://localhost:5173')
        expect(await corsHeaderFor('https://chat.example.com')).toBe('https://chat.example.com')
        expect(await corsHeaderFor('http://evil.example')).toBeNull()

        expect(await canConnectFrom('http://localhost:5173')).toBe(true)
        expect(await canConnectFrom('https://chat.example.com')).toBe(true)
        expect(await canConnectFrom(undefined)).toBe(true)
        expect(await canConnectFrom('http://evil.example')).toBe(false)
    })

    it('accepts entries written with a trailing slash, a path, or upper-case letters', async () => {
        await startWith('http://localhost:5173/, HTTPS://Chat.Example.com/app')

        expect(await corsHeaderFor('http://localhost:5173')).toBe('http://localhost:5173')
        expect(await canConnectFrom('http://localhost:5173')).toBe(true)
        expect(await canConnectFrom('https://chat.example.com')).toBe(true)
        expect(await canConnectFrom('http://evil.example')).toBe(false)
    })

    it('ignores entries that are not URLs and warns about them without printing them', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        await startWith('localhost-without-scheme, http://localhost:5173')

        expect(warn).toHaveBeenCalledOnce()
        expect(warn.mock.calls[0][0]).toMatch(/ignored 1 entry/)
        expect(warn.mock.calls[0][0]).not.toContain('localhost-without-scheme')
        expect(await canConnectFrom('http://localhost:5173')).toBe(true)
    })

    it('refuses every browser origin when nothing is configured', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})

        await startWith('')

        expect(await corsHeaderFor('http://localhost:5173')).toBeNull()
        expect(await canConnectFrom('http://localhost:5173')).toBe(false)
        expect(await canConnectFrom(undefined)).toBe(true)
    })
})
