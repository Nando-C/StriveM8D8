// The logged-in identity for this tab: the username plus the token the server issued for it.
//
// It lives in sessionStorage — per tab, gone when the tab closes. Not localStorage (that
// would outlive the tab and be shared between tabs), and not memory alone: after a network
// drop the server can keep listing the old connection for a while, and a page reload
// without the token would be told its own username is taken.

export interface Session {
  username: string
  sessionToken: string
}

const STORAGE_KEY = 'strive-chat.session'

// Used when sessionStorage is unavailable (private browsing, blocked site data).
let memoryFallback: Session | null = null

const isSession = (value: unknown): value is Session =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Session).username === 'string' &&
  typeof (value as Session).sessionToken === 'string'

export const loadSession = (): Session | null => {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY)
    if (stored === null) return memoryFallback
    const parsed: unknown = JSON.parse(stored)
    return isSession(parsed) ? parsed : null
  } catch {
    return memoryFallback
  }
}

export const saveSession = (session: Session): void => {
  memoryFallback = session
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // Kept in memory only.
  }
}

export const clearSession = (): void => {
  memoryFallback = null
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing stored to remove.
  }
}
