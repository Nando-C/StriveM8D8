import { useEffect } from 'react'
import { ask } from '@/lib/request'

/** How long without any input before the page counts as not being used. */
export const IDLE_AFTER_MS = 5 * 60_000

// Input arrives in bursts (every pixel of a pointer move); the countdown is restarted at
// most this often.
const RESTART_AT_MOST_EVERY_MS = 1000

const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

/**
 * Tells the server when nobody has used this page for five minutes, and again the moment
 * somebody does. The server shows a user as away only when every one of their devices
 * says so. A tab left in the background gets no input, so it becomes idle the same way.
 *
 * `active`: logged in and connected. Nothing is sent otherwise; each login starts as
 * "in use", which is also what the server assumes of a new connection.
 */
export const useIdleReporter = (active: boolean) => {
  useEffect(() => {
    if (!active) return

    let idle = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let restartedAt = 0

    const report = (next: boolean) => {
      if (idle === next) return
      idle = next
      void ask('setIdle', { idle })
    }
    const restart = () => {
      restartedAt = Date.now()
      clearTimeout(timer)
      timer = setTimeout(() => report(true), IDLE_AFTER_MS)
    }
    const onActivity = () => {
      // Coming back is reported at once; the countdown itself need not restart on every event.
      if (!idle && Date.now() - restartedAt < RESTART_AT_MOST_EVERY_MS) return
      report(false)
      restart()
    }
    // Looking at the page again is using it.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') onActivity()
    }

    for (const event of ACTIVITY) window.addEventListener(event, onActivity, { passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    restart()

    return () => {
      clearTimeout(timer)
      for (const event of ACTIVITY) window.removeEventListener(event, onActivity)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [active])
}
