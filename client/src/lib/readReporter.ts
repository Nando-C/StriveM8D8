import { comparePositions } from '@/lib/positions'
import type { Position } from '@/types/protocol'

/**
 * Decides when "I have read up to here" is actually sent: each position once, and at most
 * one report per conversation per `intervalMs`, however fast messages arrive. A report
 * that comes too soon after the last waits for its turn — and is replaced if a newer
 * position is offered meanwhile, so only the latest is ever sent late.
 *
 * `key` identifies a conversation *for one identity*: what one user reported says nothing
 * about the next person to log in on the same page.
 */
export const createReadReporter = (intervalMs: number) => {
  const reported = new Map<string, Position>()
  const sentAt = new Map<string, number>()
  let waiting: { timer: ReturnType<typeof setTimeout>; send: () => void } | null = null

  /** Drops the report that is waiting, if any: it is no longer wanted. */
  const cancel = () => {
    if (waiting === null) return
    clearTimeout(waiting.timer)
    waiting = null
  }

  /** Sends the waiting report now — for when the page is about to go away. */
  const flush = () => {
    const due = waiting
    cancel()
    due?.send()
  }

  /** The conversation has been read up to `position`: send that, now or when its turn comes. */
  const offer = (key: string, position: Position, send: () => void) => {
    cancel()
    if (comparePositions(position, reported.get(key)) <= 0) return
    const sendNow = () => {
      waiting = null
      reported.set(key, position)
      sentAt.set(key, Date.now())
      send()
    }
    const wait = (sentAt.get(key) ?? 0) + intervalMs - Date.now()
    if (wait <= 0) sendNow()
    else waiting = { timer: setTimeout(sendNow, wait), send: sendNow }
  }

  return { offer, cancel, flush }
}
