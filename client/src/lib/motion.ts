import type { Transition, Variants } from 'motion/react'

// One place for how the app moves, so every animation shares the same timing.
//
// Rules these follow (see CLAUDE.md): short, never blocking input, only `transform` and
// `opacity` (plus Motion's layout animations), and nothing that delays a state change.
// Reduced motion is handled once, by <MotionConfig reducedMotion="user"> around the app:
// with that preference set, Motion drops movement and scaling and keeps plain fades.

export const DURATION = { fast: 0.15, base: 0.2, slow: 0.28 } as const

/** A quick start that settles gently. */
export const EASE = [0.2, 0, 0, 1] as const

export const transition = {
  fast: { duration: DURATION.fast, ease: EASE },
  base: { duration: DURATION.base, ease: EASE },
  slow: { duration: DURATION.slow, ease: EASE },
} satisfies Record<string, Transition>

/** Fade only: views swapping, empty states, a loaded conversation. */
export const fade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: transition.base },
  exit: { opacity: 0, transition: transition.fast },
}

/** A message arriving: rises a little, from the side it belongs to. */
export const messageIn = (own: boolean): Variants => ({
  hidden: { opacity: 0, y: 8, x: own ? 8 : -8 },
  visible: { opacity: 1, y: 0, x: 0, transition: transition.base },
})

/** A person appearing in, or leaving, the list. */
export const listItem: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: transition.base },
  exit: { opacity: 0, scale: 0.96, transition: transition.fast },
}

/** The unread badge: a small pop when it appears or its count changes. */
export const pop: Variants = {
  hidden: { opacity: 0, scale: 0.6 },
  visible: { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 500, damping: 22 } },
  exit: { opacity: 0, scale: 0.6, transition: transition.fast },
}

/** The floating connection notice: slides up into place. */
export const notice: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: transition.slow },
  exit: { opacity: 0, y: 16, transition: transition.base },
}
