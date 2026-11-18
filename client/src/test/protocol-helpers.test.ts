import { describe, expect, it } from 'vitest'
import { directConversationId } from '@/lib/conversationId'
import { comparePositions } from '@/lib/positions'
import { PROTOCOL_VERSION } from '@/types/protocol'

// The two tables below are repeated, value for value, in the server's tests
// (test/conversation-units.test.js): both sides must derive the same conversation id and
// order positions the same way, and nothing else checks that.

const DIRECT_ID_CASES = [
  ['b', 'a', 'dm:a::b'],
  ['a', 'b', 'dm:a::b'],
  ['demo-bot', '7f3c2b1a-0000-4000-8000-000000000001', 'dm:7f3c2b1a-0000-4000-8000-000000000001::demo-bot'],
  ['B', 'a', 'dm:B::a'],
  ['10', '9', 'dm:10::9'],
  ['a-b', 'a', 'dm:a::a-b'],
] as const

const A = '0123456789abcdef01234567'
const B = '0123456789abcdef01234568'
const POSITION_CASES = [
  [null, null, 0],
  [null, { ts: 1, id: A }, -1],
  [{ ts: 1, id: A }, null, 1],
  [{ ts: 1, id: A }, { ts: 2, id: A }, -1],
  [{ ts: 2, id: A }, { ts: 1, id: B }, 1],
  [{ ts: 5, id: A }, { ts: 5, id: B }, -1],
  [{ ts: 5, id: B }, { ts: 5, id: A }, 1],
  [{ ts: 5, id: A }, { ts: 5, id: A }, 0],
] as const

describe('direct conversation ids', () => {
  it.each(DIRECT_ID_CASES)('%s and %s make %s', (a, b, expected) => {
    expect(directConversationId(a, b)).toBe(expected)
    expect(directConversationId(b, a)).toBe(expected)
  })
})

describe('positions', () => {
  it.each(POSITION_CASES)('compare %o with %o as %i', (a, b, expected) => {
    expect(comparePositions(a, b)).toBe(expected)
  })

  it('treat a missing position like none', () => {
    expect(comparePositions(undefined, { ts: 1, id: A })).toBe(-1)
    expect(comparePositions(undefined, null)).toBe(0)
  })
})

describe('the protocol version', () => {
  it('is the one the server speaks', () => {
    expect(PROTOCOL_VERSION).toBe(2)
  })
})
