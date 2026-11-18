import { describe, expect, it } from 'vitest'
import { directConversationId, parseDirectId, previewOf } from '../src/conversations.js'
import { comparePositions, isPosition, laterPosition } from '../src/positions.js'

// No server and no database. The two tables below are repeated, value for value, in the
// client's tests (client/src/test/protocol-helpers.test.ts): both sides must derive the
// same conversation id and order positions the same way, and nothing else checks that.

const DIRECT_ID_CASES = [
    ['b', 'a', 'dm:a::b'],
    ['a', 'b', 'dm:a::b'],
    ['demo-bot', '7f3c2b1a-0000-4000-8000-000000000001', 'dm:7f3c2b1a-0000-4000-8000-000000000001::demo-bot'],
    ['B', 'a', 'dm:B::a'],
    ['10', '9', 'dm:10::9'],
    ['a-b', 'a', 'dm:a::a-b'],
]

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
]

describe('direct conversation ids', () => {
    it.each(DIRECT_ID_CASES)('%s and %s make %s', (a, b, expected) => {
        expect(directConversationId(a, b)).toBe(expected)
        expect(directConversationId(b, a)).toBe(expected)
    })

    it('are read back only when well formed: two different ids, in order', () => {
        expect(parseDirectId('dm:a::b')).toEqual(['a', 'b'])
        for (const id of ['dm:b::a', 'dm:a::a', 'dm:a', 'dm:a::b::c', 'a::b', 'group:a::b', 'dm:a b::c', 'dm:::b', '', null, 42, { id: 'dm:a::b' }]) {
            expect(parseDirectId(id)).toBeNull()
        }
        for (const [a, b, id] of DIRECT_ID_CASES) expect(parseDirectId(id)).toEqual([a, b].sort())
    })
})

describe('positions', () => {
    it.each(POSITION_CASES)('compare %o with %o as %i', (a, b, expected) => {
        expect(comparePositions(a, b)).toBe(expected)
    })

    it('pick the later of two', () => {
        expect(laterPosition({ ts: 5, id: A }, { ts: 5, id: B })).toEqual({ ts: 5, id: B })
        expect(laterPosition(null, { ts: 1, id: A })).toEqual({ ts: 1, id: A })
        expect(laterPosition(null, null)).toBeNull()
    })

    it('are recognised strictly', () => {
        expect(isPosition({ ts: 0, id: A })).toBe(true)
        for (const value of [null, {}, { ts: 1 }, { ts: '1', id: A }, { ts: -1, id: A }, { ts: 1.5, id: A }, { ts: 1, id: 'short' }, { ts: 1, id: { $gt: '' } }, 'x']) {
            expect(isPosition(value)).toBe(false)
        }
    })
})

describe('previews', () => {
    it('are one line, trimmed, and cut at 80 characters', () => {
        expect(previewOf('  hello\n\n  there ')).toBe('hello there')
        expect(previewOf('x'.repeat(80))).toBe('x'.repeat(80))
        expect(previewOf('x'.repeat(81))).toBe(`${'x'.repeat(80)}…`)
        expect(previewOf(undefined)).toBe('')
    })
})
