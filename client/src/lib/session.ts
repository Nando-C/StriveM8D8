import type { IdentityKind } from '@/types/protocol'

// The logged-in identity for this tab: the username plus the token the server issued for it.
//
// It lives in sessionStorage — per tab, gone when the tab closes — so that two tabs can be
// two different guests. What proves a guest's name is theirs is kept separately, below.

export interface Session {
  username: string
  /** From the last `loggedin`; empty when this tab has not logged in yet. */
  sessionToken: string
  kind: IdentityKind
}

const STORAGE_KEY = 'strive-chat.session'

// Used when sessionStorage is unavailable (private browsing, blocked site data).
let memoryFallback: Session | null = null

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const toSession = (value: unknown): Session | null => {
  if (!isRecord(value) || typeof value.username !== 'string' || typeof value.sessionToken !== 'string') return null
  // Sessions stored before accounts existed have no kind: they were all guests.
  const kind: IdentityKind = value.kind === 'account' ? 'account' : 'guest'
  return { username: value.username, sessionToken: value.sessionToken, kind }
}

export const loadSession = (): Session | null => {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY)
    if (stored === null) return memoryFallback
    return toSession(JSON.parse(stored))
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

// Names are one name whatever their case (the server keeps the spelling its owner first
// chose), so a reservation is found however the name is typed this time.
export const loadReservation = (username: string): string | undefined => {
  const wanted = username.toLowerCase()
  return Object.entries(loadReservations()).find(([name]) => name.toLowerCase() === wanted)?.[1]
}

export const saveReservation = (username: string, reservation: string): void => {
  const wanted = username.toLowerCase()
  const others = Object.fromEntries(Object.entries(loadReservations()).filter(([name]) => name.toLowerCase() !== wanted))
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

// ---------- the account this browser is signed in to
//
// An account's device session is shared by every tab (each tab is one more connection of
// the same device) and outlives them, so it lives in localStorage. It is the only thing
// here that opens an account, and it stays valid until the device is signed out.

export interface StoredAccount {
  username: string
  session: string
}

const ACCOUNT_KEY = 'strive-chat.account'

let accountFallback: StoredAccount | null = null

export const loadAccount = (): StoredAccount | null => {
  try {
    const stored = window.localStorage.getItem(ACCOUNT_KEY)
    if (stored === null) return accountFallback
    const parsed: unknown = JSON.parse(stored)
    if (!isRecord(parsed) || typeof parsed.username !== 'string' || typeof parsed.session !== 'string') return null
    return { username: parsed.username, session: parsed.session }
  } catch {
    return accountFallback
  }
}

export const saveAccount = (account: StoredAccount): void => {
  accountFallback = account
  try {
    window.localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account))
  } catch {
    // Kept in memory only.
  }
}

export const clearAccount = (): void => {
  accountFallback = null
  try {
    window.localStorage.removeItem(ACCOUNT_KEY)
  } catch {
    // Nothing stored to remove.
  }
}

/**
 * Who this tab should log in as when it opens: whoever it was before a reload, or else
 * the account this browser is signed in to.
 */
export const startingSession = (): Session | null => {
  const session = loadSession()
  if (session !== null) return session
  const account = loadAccount()
  return account === null ? null : { username: account.username, sessionToken: '', kind: 'account' }
}
