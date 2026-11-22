import type { PathSample } from '@/lib/call/peer'

// Whether a call's connection is poor enough to say so: the picture freezing or the
// voice breaking up is then the network's doing, not the app's or the other person's.

/** There and back in more than this is heard as people talking over each other. */
export const SLOW_ROUND_TRIP_MS = 400
/** More than this share of packets lost is heard and seen. */
export const HEAVY_LOSS = 0.05
/** How often the path is looked at. */
export const QUALITY_PERIOD_MS = 3000
// One bad reading is a blip; it is said after this many in a row.
const READINGS_TO_SAY = 2

/** Whether the path was poor between two readings (`before`: the earlier one, if there was one). */
export const isPoorBetween = (before: PathSample | null, now: PathSample): boolean => {
  if (now.roundTripMs !== null && now.roundTripMs > SLOW_ROUND_TRIP_MS) return true
  const received = now.received - (before?.received ?? 0)
  const lost = now.lost - (before?.lost ?? 0)
  // (Counters that went backwards belong to a new path: nothing can be said of them yet.)
  if (received < 0 || lost <= 0) return false
  return lost / (received + lost) > HEAVY_LOSS
}

/** Takes readings one after another; says whether the connection is to be called poor. */
export const createQualityMeter = () => {
  let before: PathSample | null = null
  let poorInARow = 0
  return (now: PathSample): boolean => {
    poorInARow = isPoorBetween(before, now) ? poorInARow + 1 : 0
    before = now
    return poorInARow >= READINGS_TO_SAY
  }
}
