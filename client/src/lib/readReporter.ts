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
export const createReadReporter = (intervalMs: number, { maxRetryMs = 30_000 } = {}) => {
  const reported = new Map<string, Position>()
  const sentAt = new Map<string, number>()
  let waiting: { timer: ReturnType<typeof setTimeout>; send: () => void } | null = null
  // Changes whenever what is wanted changes, so that the answer to an old report can tell
  // it is no longer the current one.
  let generation = 0

  /** Drops the report that is waiting, if any: it is no longer wanted. */
  const cancel = () => {
    generation += 1
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

  /**
   * The conversation has been read up to `position`: send that, now or when its turn
   * comes. `send` resolves to whether the server took it. If it did not (no connection,
   * a refusal), the position does not count as reported and is sent again after a
   * growing pause, for as long as it is still wanted — otherwise the server would go on
   * counting as unread what has been read, on every other device and at the next login.
   */
  const offer = (key: string, position: Position, send: () => Promise<boolean>) => {
    cancel()
    if (comparePositions(position, reported.get(key)) <= 0) return
    const wanted = generation

    const sendNow = (retryIn: number) => {
      waiting = null
      reported.set(key, position)
      sentAt.set(key, Date.now())
      void send().then(taken => {
        if (taken || reported.get(key) !== position) return
        reported.delete(key)
        // Asked for something else since, or no longer reading: that will be offered afresh.
        if (generation !== wanted) return
        const again = () => sendNow(Math.min(retryIn * 2, maxRetryMs))
        waiting = { timer: setTimeout(again, retryIn), send: again }
      })
    }

    const wait = (sentAt.get(key) ?? 0) + intervalMs - Date.now()
    if (wait <= 0) sendNow(intervalMs * 2)
    else {
      const first = () => sendNow(intervalMs * 2)
      waiting = { timer: setTimeout(first, wait), send: first }
    }
  }

  return { offer, cancel, flush }
}
