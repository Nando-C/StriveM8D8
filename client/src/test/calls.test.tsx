import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { callLength, describeCall } from '@/lib/callEvents'
import {
  chatButton, conversation, dm, idOf, loginAs, message, messages, renderApp, serverSays, user,
} from '@/test/harness'
import userEvent from '@testing-library/user-event'
import type { CallRecord, ConversationSummary, Message } from '@/types/protocol'

// The line a call leaves in its conversation. (Calling itself has no screens yet.)

const mid = (n: number) => n.toString(16).padStart(24, '0')

const called = (n: number, from: string, to: string, data: unknown): Message => ({
  id: mid(n), conversationId: dm(from, to), from: idOf(from), fromName: from,
  kind: 'call', text: null, data, timestamp: n * 1000, clientId: null,
})

describe('what became of a call, in words', () => {
  it.each<[CallRecord, string, string]>([
    [{ media: 'video', outcome: 'ended', durationMs: 4 * 60_000 }, 'Video call · 4 min', 'Video call · 4 min'],
    [{ media: 'audio', outcome: 'ended', durationMs: 45_000 }, 'Voice call · 45 s', 'Voice call · 45 s'],
    // A call that was cut off was still a call.
    [{ media: 'audio', outcome: 'failed', durationMs: 65 * 60_000 }, 'Voice call · 1 h 5 min', 'Voice call · 1 h 5 min'],
    [{ media: 'video', outcome: 'failed', durationMs: 0 }, 'Video call · could not connect', 'Video call · could not connect'],
    [{ media: 'video', outcome: 'declined', durationMs: 0 }, 'Video call · declined', 'You declined a video call'],
    [{ media: 'audio', outcome: 'cancelled', durationMs: 0 }, 'Cancelled voice call', 'Missed voice call'],
    [{ media: 'video', outcome: 'missed', durationMs: 0 }, 'Video call · no answer', 'Missed video call'],
    // Why nobody answered was said to the caller at the time; in the conversation it is the same line.
    [{ media: 'video', outcome: 'unavailable', durationMs: 0 }, 'Video call · no answer', 'Missed video call'],
    [{ media: 'audio', outcome: 'dnd', durationMs: 0 }, 'Voice call · no answer', 'Missed voice call'],
    [{ media: 'audio', outcome: 'busy', durationMs: 0 }, 'Voice call · no answer', 'Missed voice call'],
    [{ media: 'video', outcome: 'ended', durationMs: 0 }, 'Video call', 'Video call'],
  ])('%o', (data, toCaller, toCalled) => {
    expect(describeCall(data, true)).toBe(toCaller)
    expect(describeCall(data, false)).toBe(toCalled)
  })

  it.each([
    [400, '1 s'], [59_400, '59 s'], [59_600, '1 min'], [3_570_000, '1 h'], [3 * 3_600_000, '3 h'], [3_900_000, '1 h 5 min'],
  ])('%i ms lasted %s', (durationMs, expected) => {
    expect(callLength(durationMs)).toBe(expected)
  })

  it('never fails on something it does not know', () => {
    for (const data of [undefined, null, 'video', {}, { media: 'hologram', outcome: 'ended' }, { media: 'video', outcome: 'vanished' }]) {
      expect(describeCall(data, true)).toBe('Call')
    }
    expect(describeCall({ media: 'video', outcome: 'ended', durationMs: 'long' }, false)).toBe('Video call')
  })
})

describe('a call in a conversation', () => {
  const missed = called(2, 'bob', 'alice', { media: 'video', outcome: 'missed', durationMs: 0 })
  const withCall = (unreadCount: number): ConversationSummary => {
    const summary = conversation('alice', 'bob', { last: message('bob', 'alice', 'x', { id: missed.id, timestamp: missed.timestamp }), unreadCount })
    return { ...summary, lastMessage: summary.lastMessage && { ...summary.lastMessage, preview: '', kind: 'call', data: missed.data } }
  }

  it('is a quiet line, worded for whoever reads it — and nothing to read', async () => {
    renderApp()
    await loginAs('alice', [user('bob')], [withCall(0)])
    // Under the name in the list: what happened, with nobody's name before it.
    expect(chatButton('bob')).toHaveTextContent('Missed video call')
    expect(chatButton('bob')).not.toHaveTextContent('bob:')

    await userEvent.click(chatButton('bob'))
    serverSays('history', {
      conversationId: dm('alice', 'bob'),
      messages: [message('bob', 'alice', 'are you there?', { id: mid(1), timestamp: 1000 }), missed],
      hasMore: false,
    })

    expect(await screen.findByText('Missed video call', { selector: 'p' })).toBeInTheDocument()
    expect(messages()).toEqual(['are you there?', 'Missed video call'])
    const line = screen.getByText('Missed video call', { selector: 'p' }).closest('li')
    expect(line).toHaveAttribute('data-system', 'true')
    expect(line?.querySelector('time')).toBeNull()
  })

  it('does not count as unread when it arrives, and reads the other way round to the one who called', async () => {
    renderApp()
    await loginAs('alice', [user('bob'), user('carol')], [conversation('alice', 'carol')])
    await userEvent.click(chatButton('carol'))

    // One that alice made, told to this device by the server like any message of hers.
    serverSays('message', called(3, 'alice', 'bob', { media: 'audio', outcome: 'declined', durationMs: 0 }))
    serverSays('message', called(4, 'bob', 'alice', { media: 'audio', outcome: 'ended', durationMs: 125_000 }))

    expect(await screen.findByText('Voice call · 2 min')).toBeInTheDocument()
    expect(chatButton('bob')).toHaveTextContent('Voice call · 2 min')
    // (A badge would say "1 unread".)
    expect(chatButton('bob')).not.toHaveTextContent(/unread/i)
  })
})
