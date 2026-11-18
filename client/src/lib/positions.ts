import type { Position } from '@/types/protocol'

// A position in a conversation: a message's timestamp and its id. Ordered the way the
// server orders history — by time, then by id — because two messages can share a
// millisecond. `null` stands for "before everything".
//
// The server has the same helper (src/positions.js); a test on each side checks the same cases.

export const comparePositions = (a: Position | null | undefined, b: Position | null | undefined): number => {
  if (a == null || b == null) return (a == null ? 0 : 1) - (b == null ? 0 : 1)
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

export const positionOf = (message: { id: string; timestamp: number }): Position => ({
  ts: message.timestamp,
  id: message.id,
})
