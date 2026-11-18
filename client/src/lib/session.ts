// The logged-in identity for this tab: the username plus the token the server issued for it.
//
// It lives in sessionStorage — per tab, gone when the tab closes — so that two tabs can be
// two different guests. What proves a guest's name is theirs is kept separately, below.

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

// ---------- guest reservations
//
// A guest's name is reserved to this browser by a secret the server hands over when the
// name is first taken. Unlike the session above it belongs in localStorage: it has to
// outlive the tab, or a guest who closes it could never have their own name back.

const RESERVATIONS_KEY = 'strive-chat.reservations'
/** Old names are dropped beyond this many; the newest are kept. */
const MAX_RESERVATIONS = 20

let reservationsFallback: Record<string, string> = {}

const loadReservations = (): Record<string, string> => {
  try {
    const stored = window.localStorage.getItem(RESERVATIONS_KEY)
    if (stored === null) return reservationsFallback
    const parsed: unknown = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return reservationsFallback
  }
}

export const loadReservation = (username: string): string | undefined => {
  const reservations = loadReservations()
  return Object.hasOwn(reservations, username) ? reservations[username] : undefined
}

export const saveReservation = (username: string, reservation: string): void => {
  const { [username]: _replaced, ...others } = loadReservations()
  // Insertion order is age: the newest goes last, the oldest fall off the front.
  const entries = [...Object.entries(others), [username, reservation] as const].slice(-MAX_RESERVATIONS)
  reservationsFallback = Object.fromEntries(entries)
  try {
    window.localStorage.setItem(RESERVATIONS_KEY, JSON.stringify(reservationsFallback))
  } catch {
    // Kept in memory only.
  }
}

/** For tests. */
export const clearReservations = (): void => {
  reservationsFallback = {}
  try {
    window.localStorage.removeItem(RESERVATIONS_KEY)
  } catch {
    // Nothing stored to remove.
  }
}
