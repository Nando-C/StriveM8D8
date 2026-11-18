import { useEffect, useState } from 'react'

// Which ways in this deployment offers, from the server's `GET /config`. It is the one
// thing the client fetches over HTTP: it is needed before anyone is logged in, to decide
// what the entry screen shows. Everything else arrives over the socket.

export interface ServerConfig {
  /** Who may create an account. */
  signup: 'open' | 'invite' | 'closed'
  /** Whether a name alone is enough to get in. */
  guests: boolean
}

/** What the public demo offers; assumed until the server says otherwise. */
export const DEFAULT_CONFIG: ServerConfig = { signup: 'open', guests: true }

const STORAGE_KEY = 'strive-chat.config'

const toConfig = (value: unknown): ServerConfig | null => {
  if (typeof value !== 'object' || value === null) return null
  const { signup, guests } = value as Record<string, unknown>
  if ((signup !== 'open' && signup !== 'invite' && signup !== 'closed') || typeof guests !== 'boolean') return null
  return { signup, guests }
}

// The last answer is remembered, so a returning visitor sees the right screen at once —
// the server may take a minute to wake before it can answer again.
const remembered = (): ServerConfig => {
  try {
    return toConfig(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? DEFAULT_CONFIG
  } catch {
    return DEFAULT_CONFIG
  }
}

export const useServerConfig = (): ServerConfig => {
  const [config, setConfig] = useState(remembered)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${import.meta.env.VITE_BACKEND_URL}/config`, { signal: controller.signal })
      .then(response => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        const fresh = toConfig(body)
        if (fresh === null) return
        setConfig(fresh)
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh))
        } catch {
          // Not remembered; asked again next time.
        }
      })
      // Unreachable or aborted: carry on with what is already assumed.
      .catch(() => {})
    return () => controller.abort()
  }, [])

  return config
}
