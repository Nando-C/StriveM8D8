import type { CallMedia, CallOutcome, CallRecord } from '@/types/protocol'

// A call leaves a line in its conversation. It arrives as data (`CallRecord`), never as
// a sentence: this is where it is put into words, for whoever is reading — the person
// who called, or the person who was called.

const MEDIA: CallMedia[] = ['audio', 'video']
const OUTCOMES: CallOutcome[] = ['ended', 'declined', 'cancelled', 'missed', 'busy', 'dnd', 'unavailable', 'failed']

/** The data of a call message, if it is one this client knows how to word. */
const asCallRecord = (data: unknown): CallRecord | null => {
  if (typeof data !== 'object' || data === null) return null
  const { media, outcome, durationMs } = data as Partial<Record<keyof CallRecord, unknown>>
  if (!MEDIA.includes(media as CallMedia) || !OUTCOMES.includes(outcome as CallOutcome)) return null
  return { media: media as CallMedia, outcome: outcome as CallOutcome, durationMs: typeof durationMs === 'number' && durationMs > 0 ? durationMs : 0 }
}

// Calls the person called did not take, whatever the reason. (As the server counts them unread.)
const MISSED: readonly unknown[] = ['missed', 'cancelled', 'unavailable', 'dnd', 'busy']

/** Whether the data of a call message says the person called missed it. */
export const isMissedCall = (data: unknown) =>
  typeof data === 'object' && data !== null && MISSED.includes((data as { outcome?: unknown }).outcome)

/** "45 s", "4 min", "1 h 5 min": how long a call lasted, to the nearest unit worth saying. */
export const callLength = (durationMs: number) => {
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${Math.max(1, seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** One line saying what became of a call. `own`: the reader is the one who called. */
export const describeCall = (data: unknown, own: boolean): string => {
  const call = asCallRecord(data)
  // Something a newer server says that this page does not know yet.
  if (call === null) return 'Call'
  const kind = call.media === 'video' ? 'video call' : 'voice call'
  const Kind = call.media === 'video' ? 'Video call' : 'Voice call'
  // Two people spoke, however it then ended.
  if (call.durationMs > 0) return `${Kind} · ${callLength(call.durationMs)}`
  if (!own && isMissedCall(call)) return `Missed ${kind}`
  switch (call.outcome) {
    case 'declined':
      return own ? `${Kind} · declined` : `You declined a ${kind}`
    case 'cancelled':
      return `Cancelled ${kind}`
    case 'failed':
      return `${Kind} · could not connect`
    case 'ended':
      return Kind
    // Nobody answered, whatever the reason: the caller was told which at the time.
    default:
      return `${Kind} · no answer`
  }
}
