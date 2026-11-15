import { useEffect, useState } from 'react'

/** Shown wherever the app is still reaching the server for the first time. */
export const WAKING_HINT = 'The demo server sleeps when idle, so the first connection can take up to a minute.'

/** How long to wait before saying anything: a normal connection takes far less. */
export const WAKING_NOTICE_DELAY_MS = 1500

/**
 * True once `active` has stayed true for `delayMs`. Used so that the "waking the server"
 * notice does not flash on every ordinary page load.
 */
export const useDelayed = (active: boolean, delayMs: number) => {
  const [elapsed, setElapsed] = useState(false)

  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => setElapsed(true), delayMs)
    return () => {
      clearTimeout(timer)
      setElapsed(false)
    }
  }, [active, delayMs])

  return active && elapsed
}
