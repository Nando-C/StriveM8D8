import type { ReactNode } from 'react'
import { MotionConfig } from 'motion/react'

/**
 * App-wide settings that every screen runs inside.
 *
 * reducedMotion="user": with the system's reduce-motion setting on, every animation in the
 * app drops its movement and scaling and keeps only a plain fade.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
