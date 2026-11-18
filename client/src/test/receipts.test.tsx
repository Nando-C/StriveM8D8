import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { READ_REPORT_INTERVAL_MS } from '@/hooks/useChat'
import type { LocalMessage } from '@/lib/messages'
import { createReadReporter } from '@/lib/readReporter'
import { audienceOf, receiptsOf, tickOf } from '@/lib/ticks'
import {
  chatButton, conversation, dm, fakeSocket, idOf, loginAs, message, messageBox, messageRow, renderApp,
  serverSays, user,
} from '@/test/harness'
import type { ConversationMember, ConversationSummary, Message, Position } from '@/types/protocol'

const mid = (n: number) => n.toString(16).padStart(24, '0')
const at = (n: number): Position => ({ ts: n * 1000, id: mid(n) })
const said = (n: number, from: string, other: string, text: string): Message =>
  message(from, from === 'alice' ? other : 'alice', text, { id: mid(n), timestamp: n * 1000 })

describe('working out a tick', () => {
  const own = (n: number): LocalMessage => ({
    key: `k${n}`, id: mid(n), clientId: null, from: 'me', fromName: 'me', kind: 'text', text: 'x',
    timestamp: n * 1000, own: true, status: 'sent', arrivedAt: null,
  })
  const member = (userId: string, positions: Partial<ConversationMember> = {}): ConversationMember => ({
    userId, username: userId, deliveredUpTo: null, readUpTo: null, ...positions,
  })
  const direct = (other: ConversationMember): ConversationSummary => ({
    id: 'dm:me::other', kind: 'direct', members: [member('me'), other], lastMessage: null, unreadCount: 0,
  })
  const group = (...others: ConversationMember[]): ConversationSummary => ({
    id: 'group:g', kind: 'group', name: 'g', members: [member('me'), ...others], lastMessage: null, unreadCount: 0,
  })

  it('goes from sent to delivered to seen as the other person’s positions pass the message', () => {
    expect(tickOf(own(5), direct(member('ana')), 'me')).toBe('sent')
    expect(tickOf(own(5), direct(member('ana', { deliveredUpTo: at(4) })), 'me')).toBe('sent')
    expect(tickOf(own(5), direct(member('ana', { deliveredUpTo: at(5) })), 'me')).toBe('delivered')
    expect(tickOf(own(5), direct(member('ana', { deliveredUpTo: at(9), readUpTo: at(4) })), 'me')).toBe('delivered')
    expect(tickOf(own(5), direct(member('ana', { deliveredUpTo: at(9), readUpTo: at(5) })), 'me')).toBe('seen')
  })

  it('takes read to imply delivered, even if no delivery was ever recorded', () => {
    expect(tickOf(own(5), direct(member('ana', { readUpTo: at(6) })), 'me')).toBe('seen')
  })

  it('tells apart two messages sent in the same millisecond', () => {
    const earlier = { ...own(5), id: mid(5), timestamp: 7000 }
    const later = { ...own(6), id: mid(6), timestamp: 7000 }
    const reader = direct(member('ana', { readUpTo: { ts: 7000, id: mid(5) } }))

    expect(tickOf(earlier, reader, 'me')).toBe('seen')
    expect(tickOf(later, reader, 'me')).toBe('sent')
  })

  it('is “sent” for anything not confirmed, not described, or with nobody to receive it', () => {
    expect(tickOf({ ...own(5), id: null }, direct(member('ana', { readUpTo: at(9) })), 'me')).toBe('sent')
    expect(tickOf(own(5), null, 'me')).toBe('sent')
    expect(tickOf(own(5), direct(member('ana', { readUpTo: at(9) })), null)).toBe('sent')
    expect(tickOf(own(5), group(), 'me')).toBe('sent')
  })

  it('counts the bot in a chat with it', () => {
    expect(tickOf(own(5), direct(member('demo-bot', { readUpTo: at(5) })), 'me')).toBe('seen')
  })

  it('in a group, needs everyone it was for', () => {
    const everyone = group(member('ana', { readUpTo: at(5) }), member('ben', { deliveredUpTo: at(5) }), member('cal'))
    expect(tickOf(own(5), everyone, 'me')).toBe('sent')

    everyone.members[3].deliveredUpTo = at(5)
    expect(tickOf(own(5), everyone, 'me')).toBe('delivered')
    expect(receiptsOf(own(5), everyone, 'me')).toEqual({ seenBy: ['ana'], deliveredTo: ['ben', 'cal'] })

    everyone.members[2].readUpTo = at(5)
    everyone.members[3].readUpTo = at(8)
    expect(tickOf(own(5), everyone, 'me')).toBe('seen')
    expect(receiptsOf(own(5), everyone, 'me')).toEqual({ seenBy: ['ana', 'ben', 'cal'], deliveredTo: [] })
  })

  it('in a group, leaves out the bot and anyone who joined after the message', () => {
    const summary = group(
      member('ana', { readUpTo: at(9) }),
      // Never reads anything it is not mentioned in.
      member('demo-bot'),
      // Added after message 5: it was never in front of them.
      member('newcomer', { joinedAfter: at(6) }),
    )

    expect(audienceOf(own(5), summary, 'me').map(each => each.userId)).toEqual(['ana'])
    expect(tickOf(own(5), summary, 'me')).toBe('seen')
    // A later message is for the newcomer too.
    expect(tickOf(own(8), summary, 'me')).toBe('sent')
    expect(audienceOf(own(8), summary, 'me').map(each => each.userId)).toEqual(['ana', 'newcomer'])
  })
})

describe('ticks on the user’s own messages', () => {
  const BOB = dm('alice', 'bob')
  const open = async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')], [conversation('alice', 'bob', { last: said(3, 'alice', 'bob', 'three') })])
    await events.click(chatButton('bob'))
    serverSays('history', {
      conversationId: BOB, hasMore: false,
      messages: [said(1, 'alice', 'bob', 'one'), said(2, 'bob', 'bob', 'two'), said(3, 'alice', 'bob', 'three')],
    })
    return events
  }
  const tick = (text: string) => messageRow(text).querySelector('[data-tick]')?.getAttribute('data-tick')
  const receipt = (deliveredUpTo: Position | null, readUpTo: Position | null) =>
    serverSays('receipt', { conversationId: BOB, userId: idOf('bob'), deliveredUpTo, readUpTo })

  it('move from sent to delivered to seen as receipts arrive, each with its name', async () => {
    await open()
    expect([tick('one'), tick('three')]).toEqual(['sent', 'sent'])
    expect(messageRow('three')).toHaveTextContent('Sent')

    receipt(at(3), at(1))
    await waitFor(() => expect([tick('one'), tick('three')]).toEqual(['seen', 'delivered']))
    expect(messageRow('three')).toHaveTextContent('Delivered')
    expect(messageRow('one')).toHaveTextContent('Seen')

    receipt(at(3), at(3))
    await waitFor(() => expect(tick('three')).toBe('seen'))
    // Two ticks rather than one — the difference is not left to colour.
    expect(messageRow('three').querySelector('[data-tick]')?.outerHTML).not.toBe(messageRow('two').querySelector('[data-tick]')?.outerHTML)
    // The other person's messages have no ticks.
    expect(messageRow('two').querySelector('[data-tick]')).toBeNull()
  })

  it('never go backwards for a receipt that arrives late or twice', async () => {
    await open()
    receipt(at(3), at(3))
    await waitFor(() => expect(tick('three')).toBe('seen'))

    receipt(at(1), null)
    receipt(null, at(1))

    await new Promise(resolve => setTimeout(resolve, 50))
    expect([tick('one'), tick('three')]).toEqual(['seen', 'seen'])
  })

  it('start from what the server says at login, so nothing is lost across a reconnect', async () => {
    renderApp()
    const summary = conversation('alice', 'bob', { last: said(3, 'alice', 'bob', 'three') })
    summary.members[1].deliveredUpTo = at(3)
    summary.members[1].readUpTo = at(1)
    const events = await loginAs('alice', [], [summary])
    await events.click(chatButton('bob'))
    serverSays('history', { conversationId: BOB, hasMore: false, messages: [said(1, 'alice', 'bob', 'one'), said(3, 'alice', 'bob', 'three')] })

    expect([tick('one'), tick('three')]).toEqual(['seen', 'delivered'])
  })

  it('apply to a message just sent, once the server has confirmed it', async () => {
    const events = await open()
    await events.type(messageBox('bob'), 'four{Enter}')
    expect(messageRow('four')).toHaveTextContent('Sending…')

    act(() => fakeSocket.last('sendmessage').ack!({ ok: true, id: mid(4), timestamp: 4000 }))
    await waitFor(() => expect(tick('four')).toBe('sent'))
    receipt(at(4), at(4))

    await waitFor(() => expect(tick('four')).toBe('seen'))
  })

  it('ignore a receipt for a conversation or a person that is not known', async () => {
    await open()

    serverSays('receipt', { conversationId: 'dm:someone::else', userId: idOf('bob'), deliveredUpTo: at(9), readUpTo: at(9) })
    serverSays('receipt', { conversationId: BOB, userId: 'a-stranger', deliveredUpTo: at(9), readUpTo: at(9) })

    expect(tick('three')).toBe('sent')
  })
})

describe('telling the sender their message arrived', () => {
  it('acknowledges every message it is sent, whichever conversation is open', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    const ack = vi.fn()

    act(() => fakeSocket.trigger('message', said(1, 'bob', 'bob', 'hello'), ack))

    expect(ack).toHaveBeenCalledOnce()
    // And copes with a server that asks for none.
    act(() => fakeSocket.trigger('message', said(2, 'bob', 'bob', 'again')))
    expect(screen.getByRole('navigation', { name: 'Chats' })).toHaveTextContent('2 unread messages')
  })
})

describe('when a conversation counts as read', () => {
  const CAROL = dm('alice', 'carol')
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const openCarol = async () => {
    renderApp()
    const events = await loginAs('alice', [], [conversation('alice', 'carol', { last: said(2, 'carol', 'carol', 'two') })])
    await events.click(chatButton('carol'))
    serverSays('history', { conversationId: CAROL, hasMore: false, messages: [said(2, 'carol', 'carol', 'two')] })
    return events
  }
  const reports = () => fakeSocket.sent<{ upTo: Position }>('markRead').map(report => report.upTo.id)

  it('does not while the window is behind another one, and does once it is in front again', async () => {
    await openCarol()
    expect(reports()).toEqual([mid(2)])

    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    act(() => void window.dispatchEvent(new Event('blur')))
    serverSays('message', said(5, 'carol', 'carol', 'are you there?'))
    await new Promise(resolve => setTimeout(resolve, READ_REPORT_INTERVAL_MS + 100))
    expect(reports()).toEqual([mid(2)])
    expect(chatButton('carol')).toHaveTextContent('1 unread message')

    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    act(() => void window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(reports()).toEqual([mid(2), mid(5)]))
  })

  it('does not while the reader has scrolled away from the end', async () => {
    // jsdom has no IntersectionObserver; this stands in for it and is driven by the test.
    let notify: (entries: { isIntersecting: boolean }[]) => void = () => {}
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof notify) {
        notify = callback
      }
      observe() {}
      disconnect() {}
    })
    await openCarol()
    expect(reports()).toEqual([mid(2)])

    // Scrolled up to read something older.
    act(() => notify([{ isIntersecting: false }]))
    serverSays('message', said(5, 'carol', 'carol', 'new, below the fold'))
    await new Promise(resolve => setTimeout(resolve, READ_REPORT_INTERVAL_MS + 100))
    expect(reports()).toEqual([mid(2)])

    // Back at the end: now it has been read.
    act(() => notify([{ isIntersecting: true }]))
    await waitFor(() => expect(reports()).toEqual([mid(2), mid(5)]))
  })

  it('reports what is still waiting when the page is closed', async () => {
    await openCarol()
    serverSays('message', said(5, 'carol', 'carol', 'just before you go'))
    // Within the second after the first report: this one is waiting its turn.
    expect(reports()).toEqual([mid(2)])

    act(() => void window.dispatchEvent(new PageTransitionEvent('pagehide')))

    expect(reports()).toEqual([mid(2), mid(5)])
    // Sent before the connection was closed, not after.
    const events = fakeSocket.emitted.map(entry => entry.event)
    expect(events.at(-1)).toBe('markRead')
    expect(fakeSocket.disconnect).toHaveBeenCalledOnce()
  })
})

describe('spacing out read reports', () => {
  it('sends the first at once, and after that the latest position once per interval', () => {
    vi.useFakeTimers()
    const reporter = createReadReporter(1000)
    const sent: number[] = []
    const offer = (n: number) => reporter.offer('k', at(n), async () => (sent.push(n), true))

    offer(1)
    expect(sent).toEqual([1])
    // A burst within the second: only the newest goes out, when the second is up.
    offer(2)
    offer(3)
    offer(4)
    expect(sent).toEqual([1])
    vi.advanceTimersByTime(999)
    expect(sent).toEqual([1])
    vi.advanceTimersByTime(1)
    expect(sent).toEqual([1, 4])

    // Nothing new: nothing sent. Something older: nothing sent.
    offer(4)
    offer(2)
    vi.advanceTimersByTime(5000)
    expect(sent).toEqual([1, 4])
    // After a quiet spell the next one is immediate again.
    offer(5)
    expect(sent).toEqual([1, 4, 5])
  })

  it('keeps conversations apart, drops what is cancelled, and sends early when flushed', () => {
    vi.useFakeTimers()
    const reporter = createReadReporter(1000)
    const sent: string[] = []

    reporter.offer('a', at(1), async () => (sent.push('a1'), true))
    reporter.offer('b', at(1), async () => (sent.push('b1'), true))
    expect(sent).toEqual(['a1', 'b1'])

    reporter.offer('a', at(2), async () => (sent.push('a2'), true))
    reporter.cancel()
    vi.advanceTimersByTime(5000)
    expect(sent).toEqual(['a1', 'b1'])

    // It was never sent, so it can be offered again.
    vi.setSystemTime(Date.now() - 4500)
    reporter.offer('b', at(2), async () => (sent.push('b2'), true))
    expect(sent).toEqual(['a1', 'b1'])
    reporter.flush()
    expect(sent).toEqual(['a1', 'b1', 'b2'])
    reporter.flush()
    expect(sent).toEqual(['a1', 'b1', 'b2'])
  })
})

describe('a read report the server did not take', () => {
  it('does not count as reported: it is sent again, with a growing pause, until it is taken', async () => {
    vi.useFakeTimers()
    const reporter = createReadReporter(1000, { maxRetryMs: 5000 })
    const answers = [false, false, false, true]
    let attempts = 0
    reporter.offer('k', at(1), async () => answers[attempts++])

    expect(attempts).toBe(1)
    // 2 s after the first refusal, 4 s after the second, then no more than the ceiling.
    await vi.advanceTimersByTimeAsync(1999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(4000)
    expect(attempts).toBe(3)
    await vi.advanceTimersByTimeAsync(5000)
    expect(attempts).toBe(4)
    // Taken: nothing more.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toBe(4)
  })

  it('is not retried once it is no longer wanted, and gives way to a newer position', async () => {
    vi.useFakeTimers()
    const reporter = createReadReporter(1000)
    const sent: number[] = []
    reporter.offer('k', at(1), async () => (sent.push(1), false))
    await vi.advanceTimersByTimeAsync(0)

    // The reader moved on to a newer message before the retry was due.
    await vi.advanceTimersByTimeAsync(1000)
    reporter.offer('k', at(2), async () => (sent.push(2), true))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toEqual([1, 2])

    // And a refused report whose conversation was closed is simply dropped.
    reporter.offer('other', at(1), async () => (sent.push(9), false))
    await vi.advanceTimersByTimeAsync(0)
    reporter.cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toEqual([1, 2, 9])
    // It was never taken, so offering it again sends it again.
    reporter.offer('other', at(1), async () => (sent.push(9), true))
    expect(sent).toEqual([1, 2, 9, 9])
  })

  it('is tried again by the app when the server refuses it', async () => {
    renderApp()
    const events = await loginAs('alice', [], [conversation('alice', 'carol', { last: said(2, 'carol', 'carol', 'two') })])
    await events.click(chatButton('carol'))
    serverSays('history', { conversationId: dm('alice', 'carol'), hasMore: false, messages: [said(2, 'carol', 'carol', 'two')] })
    expect(fakeSocket.sent('markRead')).toHaveLength(1)

    act(() => fakeSocket.last('markRead').ack!({ ok: false, message: 'Could not be saved' }))

    await waitFor(() => expect(fakeSocket.sent('markRead')).toHaveLength(2), { timeout: READ_REPORT_INTERVAL_MS * 2 + 1500 })
    expect(fakeSocket.sent('markRead')[1]).toEqual(fakeSocket.sent('markRead')[0])
    // Once taken, it is left alone.
    act(() => fakeSocket.last('markRead').ack!({ ok: true }))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(fakeSocket.sent('markRead')).toHaveLength(2)
  }, 10_000)
})
