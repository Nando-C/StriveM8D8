import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { MotionGlobalConfig } from 'motion/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { clearAccount, clearReservations, clearSession } from '@/lib/session'
import { fakeSocket } from '@/test/fakeSocket'

// Every test runs against the fake socket: nothing here ever opens a network connection.
vi.mock('@/lib/socket', async () => {
  const { fakeSocket: socket } = await import('@/test/fakeSocket')
  return { socket }
})

// These tests are about behaviour, not motion: animations finish instantly, so an element
// that is removed is gone at once instead of lingering for its exit animation.
MotionGlobalConfig.skipAnimations = true

/** What the fake server answers on GET /config; `null` makes it unreachable. */
export const serverConfig: { current: object | null } = { current: null }

/** Controls what `prefers-reduced-motion` and friends report. */
export const mediaQueries = { reducedMotion: false }

// jsdom lacks a few browser APIs the UI components rely on.
window.matchMedia = (query: string) =>
  ({
    matches: query.includes('prefers-reduced-motion') ? mediaQueries.reducedMotion : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList
Element.prototype.scrollIntoView = () => {}
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  mediaQueries.reducedMotion = false
  serverConfig.current = { signup: 'open', guests: true, protocol: 1 }
  // The one thing the client may fetch is the server's /config; anything else is a mistake.
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) =>
      String(input).endsWith('/config') && serverConfig.current !== null
        ? Promise.resolve(new Response(JSON.stringify(serverConfig.current)))
        : Promise.reject(new Error(`the client must not fetch ${String(input)}`)),
    ),
  )
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  cleanup()
  fakeSocket.reset()
  clearSession()
  clearReservations()
  clearAccount()
  window.sessionStorage.clear()
  window.localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
