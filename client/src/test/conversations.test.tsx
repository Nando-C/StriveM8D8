import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chatButton, connectAs, conversation, disconnect, dm, fakeSocket, idOf, listedChats, loggedInPayload, loginAs,
  message, messageBox, messages, personButton, renderApp, serverSays, user,
} from '@/test/harness'
import type { Message } from '@/types/protocol'

const mid = (n: number) => n.toString(16).padStart(24, '0')
const said = (n: number, from: string, other: string, text: string, timestamp = n * 1000): Message =>
  message(from, from === 'alice' ? other : 'alice', text, { id: mid(n), timestamp })

const BOB = dm('alice', 'bob')
const CAROL = dm('alice', 'carol')
const history = (conversationId: string, list: Message[], hasMore = false) =>
  serverSays('history', { conversationId, messages: list, hasMore })
const position = (n: number, timestamp = n * 1000) => ({ ts: timestamp, id: mid(n) })

// Alice logs in with two conversations: an unread one with bob (newer) and a read one with carol.
const withTwoChats = async () => {
  renderApp()
  return loginAs('alice', [user('bob')], [
    conversation('alice', 'bob', { last: said(5, 'bob', 'bob', 'are you coming?'), unreadCount: 2 }),
    conversation('alice', 'carol', { last: said(2, 'alice', 'carol', 'see you then') }),
  ])
}

describe('the chat list', () => {
  it('shows the user’s conversations from login, most recent first, with a preview and unread count', async () => {
    await withTwoChats()

    expect(listedChats()).toEqual(['bob', 'carol'])
    expect(chatButton('bob')).toHaveTextContent('are you coming?')
    expect(chatButton('bob')).toHaveTextContent('2 unread messages')
    // The user's own last message is marked as theirs; a read chat has no badge.
    expect(chatButton('carol')).toHaveTextContent('You: see you then')
    expect(chatButton('carol')).not.toHaveTextContent('unread')
    // Carol is not connected, and is still there to write to.
    expect(screen.getByRole('navigation', { name: 'People online' })).not.toHaveTextContent('carol')
  })

  it('is not shown at all while there are no conversations', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])

    expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument()
  })

  it('puts the unread total in the tab title, and takes it away when everything is read', async () => {
    const events = await withTwoChats()
    expect(document.title).toBe('(2) Strive Chat')

    serverSays('message', said(6, 'carol', 'carol', 'on my way'))
    expect(document.title).toBe('(3) Strive Chat')

    await events.click(chatButton('carol'))
    await events.click(chatButton('bob'))
    expect(document.title).toBe('Strive Chat')
  })

  it('moves a conversation to the top when a message arrives in it, and updates its preview', async () => {
    await withTwoChats()

    serverSays('message', said(6, 'carol', 'carol', 'on my   way\nnow'))

    await waitFor(() => expect(listedChats()).toEqual(['carol', 'bob']))
    expect(chatButton('carol')).toHaveTextContent('on my way now')
    expect(chatButton('carol')).toHaveTextContent('1 unread message')
  })

  it('lists a new conversation as soon as the first message is typed, before the server has confirmed anything', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')])
    await events.click(personButton('bob'))
    expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument()

    await events.type(messageBox('bob'), 'hello bob{Enter}')

    expect(listedChats()).toEqual(['bob'])
    expect(chatButton('bob')).toHaveTextContent('You: hello bob')
    expect(chatButton('bob')).toHaveAttribute('aria-current', 'true')
  })

  it('takes a conversation it has never seen from the first message, then from the server’s description — counting once', async () => {
    renderApp()
    await loginAs('alice')
    const first = said(1, 'dave', 'dave', 'hi, I am dave')

    // The message arrives first; who is in the conversation follows.
    serverSays('message', first)
    expect(listedChats()).toEqual(['dave'])
    expect(chatButton('dave')).toHaveTextContent('1 unread message')

    serverSays('conversationUpdated', { conversation: conversation('alice', 'dave', { last: first, unreadCount: 1 }) })
    expect(listedChats()).toEqual(['dave'])
    expect(chatButton('dave')).toHaveTextContent('1 unread message')
    expect(document.title).toBe('(1) Strive Chat')
  })

  it('drops the unread badge when another of the user’s devices has read the conversation', async () => {
    await withTwoChats()

    serverSays('conversationUpdated', { conversation: conversation('alice', 'bob', { last: said(5, 'bob', 'bob', 'are you coming?'), unreadCount: 0 }) })

    // The badge fades out, so it is gone a moment later rather than at once.
    await waitFor(() => expect(chatButton('bob')).not.toHaveTextContent('unread'))
    expect(document.title).toBe('Strive Chat')
  })

  it('shows whose chat it was when the other person is gone', async () => {
    renderApp()
    const gone = conversation('alice', 'bob', { last: said(1, 'bob', 'bob', 'bye') })
    gone.members[1].gone = true

    await loginAs('alice', [], [gone])

    expect(chatButton('bob')).toHaveTextContent('No longer here')
  })

  it('keeps conversations and their loaded messages across a reconnect, laying the server’s new summaries over them', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('carol'))
    history(CAROL, [said(2, 'alice', 'carol', 'see you then')])
    disconnect()
    connectAs('socket-2')

    serverSays('loggedin', loggedInPayload('alice', [], 'token-2', undefined, [
      conversation('alice', 'carol', { last: said(7, 'carol', 'carol', 'here now'), unreadCount: 1 }),
      conversation('alice', 'bob', { last: said(5, 'bob', 'bob', 'are you coming?'), unreadCount: 2 }),
    ]))

    expect(listedChats()).toEqual(['carol', 'bob'])
    expect(messages()).toEqual(['see you then'])
    // The open conversation is on screen, so nothing in it counts as unread.
    expect(chatButton('carol')).not.toHaveTextContent('unread')
    expect(fakeSocket.sent('getHistory').at(-1)).toEqual({ conversationId: CAROL })
  })
})

describe('reading', () => {
  it('opens an unread conversation at a “New messages” line, and tells the server how far it has been read', async () => {
    renderApp()
    const summary = conversation('alice', 'bob', { last: said(5, 'bob', 'bob', 'five'), unreadCount: 2 })
    summary.members[0].readUpTo = position(3)
    const events = await loginAs('alice', [user('bob')], [summary])

    await events.click(chatButton('bob'))
    expect(chatButton('bob')).not.toHaveTextContent('unread')
    // Nothing is reported as read before there is anything on screen to have read.
    expect(fakeSocket.sent('markRead')).toEqual([])

    history(BOB, [said(1, 'bob', 'bob', 'one'), said(2, 'alice', 'bob', 'two'), said(3, 'bob', 'bob', 'three'), said(4, 'bob', 'bob', 'four'), said(5, 'bob', 'bob', 'five')])

    const rows = within(screen.getByRole('log')).getAllByRole('listitem').map(row => row.querySelector('p')?.textContent)
    const log = screen.getByRole('log')
    const divider = within(log).getByRole('separator', { name: 'New messages' })
    // The line sits between the last message read and the first one not.
    expect(divider.previousElementSibling).toHaveTextContent('three')
    expect(divider.nextElementSibling).toHaveTextContent('four')
    expect(rows).toEqual(['one', 'two', 'three', 'four', 'five'])
    expect(fakeSocket.sent('markRead')).toEqual([{ conversationId: BOB, upTo: position(5) }])
  })

  it('shows no line in a conversation that had nothing unread', async () => {
    const events = await withTwoChats()

    await events.click(chatButton('carol'))
    history(CAROL, [said(1, 'carol', 'carol', 'one'), said(2, 'alice', 'carol', 'see you then')])

    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('puts the line before the first message when nothing had been read at all', async () => {
    const events = await withTwoChats()

    await events.click(chatButton('bob'))
    history(BOB, [said(4, 'bob', 'bob', 'hello?'), said(5, 'bob', 'bob', 'are you coming?')])

    expect(screen.getByRole('separator', { name: 'New messages' }).nextElementSibling).toHaveTextContent('hello?')
  })

  it('reports each new position once: again for a message that arrives while the conversation is open, not for a repeat', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('carol'))
    history(CAROL, [said(2, 'alice', 'carol', 'see you then')])
    expect(fakeSocket.sent('markRead')).toEqual([{ conversationId: CAROL, upTo: position(2) }])

    serverSays('message', said(6, 'carol', 'carol', 'on my way'))
    serverSays('message', said(6, 'carol', 'carol', 'on my way'))
    history(CAROL, [said(2, 'alice', 'carol', 'see you then'), said(6, 'carol', 'carol', 'on my way')])

    expect(fakeSocket.sent('markRead')).toEqual([
      { conversationId: CAROL, upTo: position(2) },
      { conversationId: CAROL, upTo: position(6) },
    ])
    // A message for a conversation that is not on screen is not read.
    serverSays('message', said(7, 'bob', 'bob', 'hello??'))
    expect(fakeSocket.sent('markRead')).toHaveLength(2)
  })

  it('reports nothing while disconnected, and catches up after logging back in', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('carol'))
    history(CAROL, [said(2, 'alice', 'carol', 'see you then')])
    disconnect()
    connectAs('socket-2')
    const before = fakeSocket.sent('markRead').length

    serverSays('loggedin', loggedInPayload('alice', [], 'token-2', undefined, [conversation('alice', 'carol', { last: said(8, 'carol', 'carol', 'hello?') })]))
    expect(fakeSocket.sent('markRead')).toHaveLength(before)
    history(CAROL, [said(2, 'alice', 'carol', 'see you then'), said(8, 'carol', 'carol', 'hello?')])

    expect(fakeSocket.sent('markRead').at(-1)).toEqual({ conversationId: CAROL, upTo: position(8) })
  })

  it('counts its own sent message as read up to there, once the server has confirmed it', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')])
    await events.click(personButton('bob'))
    await events.type(messageBox('bob'), 'hello bob{Enter}')
    expect(fakeSocket.sent('markRead')).toEqual([])

    act(() => fakeSocket.last('sendmessage').ack!({ ok: true, id: mid(1), timestamp: 1000 }))

    expect(fakeSocket.sent('markRead')).toEqual([{ conversationId: BOB, upTo: position(1) }])
  })
})

describe('earlier messages', () => {
  const page = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_unused, index) => said(from + index, 'bob', 'bob', `message ${from + index}`))

  it('are offered only when the server has more, and asked for from the oldest message shown', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('bob'))

    history(BOB, page(101, 103), true)
    await events.click(screen.getByRole('button', { name: 'Load earlier messages' }))

    expect(fakeSocket.sent('getHistory').at(-1)).toEqual({ conversationId: BOB, before: position(101) })
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled()
    // One request at a time.
    expect(fakeSocket.sent('getHistory')).toHaveLength(2)

    history(BOB, page(98, 100), false)

    expect(messages()).toEqual(['message 98', 'message 99', 'message 100', 'message 101', 'message 102', 'message 103'])
    expect(screen.queryByRole('button', { name: /earlier|Loading/ })).not.toBeInTheDocument()
  })

  it('are not offered again just because the newest page was fetched once more', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('bob'))
    history(BOB, page(101, 103), true)
    await events.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    history(BOB, page(98, 100), false)

    // After a reconnect the newest page arrives again, and says there is more before *it*.
    history(BOB, page(101, 103), true)

    expect(messages()).toHaveLength(6)
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument()
  })

  it('stop waiting if the request fails or the connection drops', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('bob'))
    history(BOB, page(101, 103), true)
    await events.click(screen.getByRole('button', { name: 'Load earlier messages' }))

    serverSays('historyError', { conversationId: BOB, message: 'History could not be loaded' })

    expect(screen.getByRole('alert')).toHaveTextContent('History could not be loaded')
    expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeEnabled()
  })
})

describe('a page older than the server', () => {
  it('says a new version is available and offers to reload, instead of half-working', async () => {
    renderApp({ connected: false })

    act(() => fakeSocket.trigger('connect_error', Object.assign(new Error('Unsupported protocol version'), { data: { code: 'protocol', protocol: 3 } })))

    expect(await screen.findByRole('alert')).toHaveTextContent('A new version is available')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
  })

  it('is not assumed from any other connection problem', async () => {
    renderApp({ connected: false })

    act(() => fakeSocket.trigger('connect_error', new Error('websocket error')))

    expect(screen.getByLabelText('Username')).toBeInTheDocument()
    expect(screen.queryByText('A new version is available')).not.toBeInTheDocument()
  })

  it('connects saying which version of the protocol it speaks', async () => {
    const { PROTOCOL_VERSION } = await import('@/types/protocol')
    const source = (await import('@/lib/socket?raw')).default as string

    expect(PROTOCOL_VERSION).toBe(2)
    expect(source).toContain('auth: { protocol: PROTOCOL_VERSION }')
  })
})

describe('ids', () => {
  it('never puts a user id on screen', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('bob'))
    history(BOB, [said(4, 'bob', 'bob', 'hello?')])

    expect(document.body.textContent).not.toContain(idOf('bob'))
    expect(document.body.textContent).not.toContain(idOf('alice'))
  })
})

describe('a conversation open in a tab nobody is looking at', () => {
  const setVisible = (visible: boolean) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') })
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
  }
  // jsdom's own answer is "visible"; put it back however a test ends.
  afterEach(() => setVisible(true))

  it('is not read: a message that arrives there is counted, shown in the title, and not reported', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('carol'))
    history(CAROL, [said(2, 'alice', 'carol', 'see you then')])
    const reported = fakeSocket.sent('markRead').length

    setVisible(false)
    serverSays('message', said(6, 'carol', 'carol', 'on my way'))

    expect(fakeSocket.sent('markRead')).toHaveLength(reported)
    expect(chatButton('carol')).toHaveTextContent('1 unread message')
    // Two were unread in the other conversation already.
    expect(document.title).toBe('(3) Strive Chat')
  })

  it('is read when they look again: reported then, with the new messages pointed out', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('carol'))
    history(CAROL, [said(2, 'alice', 'carol', 'see you then')])
    setVisible(false)
    serverSays('message', said(6, 'carol', 'carol', 'on my way'))
    serverSays('message', said(7, 'carol', 'carol', 'here'))

    setVisible(true)

    expect(fakeSocket.sent('markRead').at(-1)).toEqual({ conversationId: CAROL, upTo: position(7) })
    await waitFor(() => expect(chatButton('carol')).not.toHaveTextContent('unread'))
    expect(document.title).toBe('(2) Strive Chat')
    expect(screen.getByRole('separator', { name: 'New messages' }).nextElementSibling).toHaveTextContent('on my way')
  })

  it('does not count as read on another device either, when the server says there is something new', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('carol'))
    setVisible(false)

    serverSays('conversationUpdated', { conversation: conversation('alice', 'carol', { last: said(6, 'carol', 'carol', 'on my way'), unreadCount: 1 }) })

    expect(chatButton('carol')).toHaveTextContent('1 unread message')
  })
})

describe('more than a page of messages arriving while away', () => {
  const page = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_unused, index) => said(from + index, 'carol', 'carol', `message ${from + index}`))

  it('leaves no hole: what was held from before the gap is let go, and earlier pages lead back through it', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('carol'))
    history(CAROL, page(1, 3))
    disconnect()
    connectAs('socket-2')
    serverSays('loggedin', loggedInPayload('alice', [], 'token-2', undefined, [conversation('alice', 'carol', { last: said(250, 'carol', 'carol', 'message 250') })]))

    // The newest page starts long after the last message held, and says there is more before it.
    history(CAROL, page(248, 250), true)

    expect(messages()).toEqual(['message 248', 'message 249', 'message 250'])
    await events.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    // Asked for from the start of what is shown now — not from before message 1.
    expect(fakeSocket.sent('getHistory').at(-1)).toEqual({ conversationId: CAROL, before: position(248) })
  })

  it('keeps everything when the newest page overlaps what is held', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('carol'))
    history(CAROL, page(1, 3))

    history(CAROL, page(3, 5), true)

    expect(messages()).toEqual(['message 1', 'message 2', 'message 3', 'message 4', 'message 5'])
  })

  it('keeps a message of the user’s own that was never confirmed', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('carol'))
    history(CAROL, page(1, 3))
    await events.type(messageBox('carol'), 'did this go?{Enter}')
    disconnect()
    connectAs('socket-2')
    serverSays('loggedin', loggedInPayload('alice', [], 'token-2'))

    history(CAROL, page(248, 250), true)

    expect(messages()).toEqual(['message 248', 'message 249', 'message 250', 'did this go?'])
  })
})

describe('the same name coming back as a different identity', () => {
  it('starts from nothing: the previous identity’s conversations are not shown as this one’s', async () => {
    const events = await withTwoChats()
    await events.click(chatButton('carol'))
    history(CAROL, [said(2, 'alice', 'carol', 'see you then')])
    disconnect()
    connectAs('socket-2')

    // The guest name lapsed while the tab slept, and was reserved afresh: a new userId.
    serverSays('loggedin', { ...loggedInPayload('alice', [user('bob')], 'token-2', 'a-new-secret'), userId: 'a-different-id' })

    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument())
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
    expect(document.title).toBe('Strive Chat')
    // And a conversation is opened under the new identity's id.
    await events.click(personButton('bob'))
    expect(fakeSocket.sent('getHistory').at(-1)).toEqual({ conversationId: 'dm:a-different-id::bob-id' })
  })
})
