import type { ShownStatus, Status, UserKind } from '@/types/protocol'

/** The small label beside the name of someone who is not an account. */
export const KIND_LABELS: Partial<Record<UserKind, string>> = { guest: 'Guest', bot: 'Bot' }

/** How someone appears: one of the statuses others can be shown, or not connected. */
export type Presence = ShownStatus | 'offline'

export const STATUS_LABELS: Record<Status | 'offline', string> = {
  online: 'Online',
  away: 'Away',
  dnd: 'Do not disturb',
  invisible: 'Invisible',
  offline: 'Offline',
}

/** What each choice means, for the status menu. */
export const STATUS_HINTS: Record<Status, string> = {
  online: 'Shown as away after five minutes without activity',
  away: 'Shown as away until you change it',
  dnd: 'Shown as not to be disturbed',
  invisible: 'Shown as offline; you can still read and write',
}

export const STATUS_CHOICES: Status[] = ['online', 'away', 'dnd', 'invisible']

export const MAX_STATUS_TEXT_LENGTH = 80

/** How long a status message can be set to stay. */
export const CLEAR_AFTER_CHOICES = ['30m', '1h', '4h', 'today', 'never'] as const
export type ClearAfter = (typeof CLEAR_AFTER_CHOICES)[number]

export const CLEAR_AFTER_LABELS: Record<ClearAfter, string> = {
  '30m': '30 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  today: 'Today',
  never: 'Don’t clear',
}

/** The choice as the server wants it: minutes from now, or `null` for "stays". */
export const clearAfterMinutes = (choice: ClearAfter, now = new Date()): number | null => {
  switch (choice) {
    case '30m':
      return 30
    case '1h':
      return 60
    case '4h':
      return 240
    case 'today': {
      // Until midnight, wherever the reader is.
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 60_000))
    }
    case 'never':
      return null
  }
}

/** A person's second line: their kind (if it is worth saying), how they appear, and their own words. */
export const presenceLine = (kindLabel: string | undefined, presence: Presence, statusText: string) => {
  const line = [kindLabel, STATUS_LABELS[presence]].filter(part => part !== undefined).join(' · ')
  return statusText === '' ? line : `${line} — ${statusText}`
}
