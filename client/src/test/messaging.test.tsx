import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  chatButton, conversation, disconnect, dm, fakeSocket, idOf, loginAs, message, messageBox, messageRow, messages, personButton, renderApp,
  sendButton, serverSays, user,
} from '@/test/harness'
import type { Message, SendMessagePayload } from '@/types/protocol'

/** A valid message id: 24 hex digits, sorting in the order of `n`. */
const mid = (n: number) => n.toString(16).padStart(24, '0')

/** A message in the chat between alice (the user) and `other`, written by `from`. */
const said = (n: number, from: string, other: string, text: string, timestamp: number, clientId: string | null = null): Message =>
  message(from, from === 'alice' ? other : 'alice', text, { id: mid(n), timestamp, clientId })

const BOB = dm('alice', 'bob')
const CAROL = dm('alice', 'carol')
const history = (conversationId: string, list: Message[], hasMore = false) =>
  serverSays('history', { conversationId, messages: list, hasMore })

const openChatWithBob = async () => {
  renderApp()
  const events = await loginAs('alice', [user('bob'), user('carol')])
  await events.click(personButton('bob'))
  return events
}

describe('opening a conversation', () => {
  it('requests its history by the conversation’s id and shows what comes back, oldest first', async () => {
    await openChatWithBob()

    // The id is worked out from the two user ids: nothing was asked of the server to get it.
    expect(fakeSocket.sent('getHistory')).toEqual([{ conversationId: `dm:${idOf('alice')}::${idOf('bob')}` }])
    expect(screen.getByText('No messages yet')).toBeInTheDocument()

    history(BOB, [said(1, 'bob', 'bob', 'hi', 1000), said(2, 'alice', 'bob', 'hello', 2000, 'c2')])

    expect(messages()).toEqual(['hi', 'hello'])
    expect(messageRow('hello')).toHaveTextContent('You:')
    expect(messageRow('hi')).toHaveTextContent('bob:')
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument()
  })

  it('shows a history error in the conversation it belongs to', async () => {
    await openChatWithBob()

    serverSays('historyError', { conversationId: BOB, message: 'History could not be loaded' })

    expect(screen.getByRole('alert')).toHaveTextContent('History could not be loaded')
  })

  it('files a late history response under the conversation it names, not the one on screen', async () => {
    const events = await openChatWithBob()
    await events.click(personButton('carol'))

    // Bob's history arrives only now, after the switch to Carol.
    history(BOB, [said(1, 'bob', 'bob', 'for the bob chat', 1000)])

    expect(messages()).toEqual([])
    await events.click(personButton('bob'))
    expect(messages()).toEqual(['for the bob chat'])
  })
})

describe('receiving messages', () => {
  it('adds a message from the open conversation exactly once', async () => {
    await openChatWithBob()

    serverSays('message', said(1, 'bob', 'bob', 'hello alice', 1000))
    // The same message delivered twice (or again through history) is still one message.
    serverSays('message', said(1, 'bob', 'bob', 'hello alice', 1000))
    history(BOB, [said(1, 'bob', 'bob', 'hello alice', 1000)])

    expect(messages()).toEqual(['hello alice'])
  })

  it('keeps messages for a conversation that is not open, counts them, and shows each once when opened', async () => {
    const events = await openChatWithBob()

    serverSays('message', said(1, 'carol', 'carol', 'one', 1000))
    serverSays('message', said(2, 'carol', 'carol', 'two', 2000))
    serverSays('message', said(3, 'carol', 'carol', 'three', 3000))

    expect(messages()).toEqual([])
    expect(screen.getByRole('navigation', { name: 'Chats' })).toHaveTextContent('3 unread messages')
    expect(screen.getByText('New message from carol')).toBeInTheDocument()

    await events.click(personButton('carol'))
    history(CAROL, [said(1, 'carol', 'carol', 'one', 1000), said(2, 'carol', 'carol', 'two', 2000), said(3, 'carol', 'carol', 'three', 3000)])

    expect(messages()).toEqual(['one', 'two', 'three'])
    expect(screen.getByRole('navigation', { name: 'Chats' })).not.toHaveTextContent('unread')
  })

  it('orders merged messages by time, whatever order they arrived in', async () => {
    await openChatWithBob()

    serverSays('message', said(3, 'bob', 'bob', 'third', 3000))
    history(BOB, [said(1, 'bob', 'bob', 'first', 1000), said(2, 'alice', 'bob', 'second', 2000, 'c2')])

    expect(messages()).toEqual(['first', 'second', 'third'])
  })

  it('shows a message the user sent from another device as their own, without counting it as unread', async () => {
    const events = await openChatWithBob()
    await events.click(personButton('carol'))

    // Sent from the user's phone, to bob: echoed here by the server.
    serverSays('message', said(1, 'alice', 'bob', 'from my phone', 1000, 'a-client-id-from-the-phone'))

    expect(screen.getByRole('navigation', { name: 'Chats' })).not.toHaveTextContent('unread')
    expect(screen.queryByText(/New message from/)).not.toBeInTheDocument()
    await events.click(personButton('bob'))
    expect(messageRow('from my phone')).toHaveTextContent('You:')
    expect(messageRow('from my phone')).toHaveTextContent('Sent')
  })
})

describe('sending messages', () => {
  it('sends to the conversation with a client id, and shows the message as sending', async () => {
    const events = await openChatWithBob()

    await events.type(messageBox('bob'), 'hello bob')
    await events.click(sendButton())

    const payload = fakeSocket.last('sendmessage').payload as SendMessagePayload
    expect(payload).toEqual({ conversationId: BOB, text: 'hello bob', clientId: expect.any(String) })
    expect(payload.clientId).toMatch(/^[A-Za-z0-9-]{1,64}$/)
    expect(messages()).toEqual(['hello bob'])
    expect(messageRow('hello bob')).toHaveTextContent('Sending…')
    expect(messageBox('bob')).toHaveValue('')
  })

  it('marks the message sent when the server acknowledges it', async () => {
    const events = await openChatWithBob()
    await events.type(messageBox('bob'), 'hello bob{Enter}')

    act(() => fakeSocket.last('sendmessage').ack!({ ok: true, id: mid(1), timestamp: 5000 }))

    expect(await screen.findByText('Sent')).toBeInTheDocument()
    expect(messageRow('hello bob')).not.toHaveTextContent('Sending…')
    expect(messages()).toEqual(['hello bob'])
  })

  it('marks the message failed, with the reason, when the server refuses it', async () => {
    const events = await openChatWithBob()
    await events.type(messageBox('bob'), 'hello bob{Enter}')

    act(() => fakeSocket.last('sendmessage').ack!({ ok: false, message: 'Message could not be saved' }))

    expect(await screen.findByText(/Not sent — Message could not be saved/)).toBeInTheDocument()
    expect(messageRow('hello bob')).not.toHaveTextContent('Sent')
  })

  it('does not show a message that failed as the last thing said, once more has been said', async () => {
    const events = await openChatWithBob()
    await events.type(messageBox('bob'), 'never sent{Enter}')
    act(() => fakeSocket.last('sendmessage').ack!({ ok: false, message: 'Too many requests, slow down' }))
    await screen.findByText(/Not sent/)

    serverSays('message', message('bob', 'alice', 'did you say something?'))
    expect(chatButton('bob')).toHaveTextContent('did you say something?')
    expect(chatButton('bob')).not.toHaveTextContent('never sent')
    // It is still there to be tried again.
    expect(messageRow('never sent')).toHaveTextContent('Not sent')
  })

  it('can send while the other person is offline: the message waits for them', async () => {
    const events = await openChatWithBob()

    serverSays('userLeft', { userId: idOf('bob') })

    expect(messageBox('bob')).toBeEnabled()
    expect(screen.getByRole('heading', { name: 'bob' }).parentElement).toHaveTextContent('Offline — they will see your messages when they are back')
    await events.type(messageBox('bob'), 'for later{Enter}')
    expect(fakeSocket.sent('sendmessage')).toEqual([{ conversationId: BOB, text: 'for later', clientId: expect.any(String) }])
  })

  it('cannot send to someone who is no longer here', async () => {
    const events = await openChatWithBob()
    history(BOB, [said(1, 'bob', 'bob', 'bye', 1000)])

    serverSays('conversationUpdated', {
      conversation: {
        id: BOB, kind: 'direct', lastMessage: null, unreadCount: 0,
        members: [
          { userId: idOf('alice'), username: 'alice', deliveredUpTo: null, readUpTo: null },
          { userId: idOf('bob'), username: 'bob', deliveredUpTo: null, readUpTo: null, gone: true },
        ],
      },
    })

    expect(messageBox('bob')).toBeDisabled()
    expect(sendButton()).toBeDisabled()
    expect(messageBox('bob')).toHaveAttribute('placeholder', 'bob is no longer here')
    // What was said is still there to read.
    expect(messages()).toEqual(['bye'])
    await events.keyboard('{Enter}')
    expect(fakeSocket.sent('sendmessage')).toEqual([])
  })

  it('keeps a pending and a failed message through a history merge, after the confirmed ones', async () => {
    const events = await openChatWithBob()
    await events.type(messageBox('bob'), 'this one fails{Enter}')
    act(() => fakeSocket.last('sendmessage').ack!({ ok: false, message: 'Message could not be saved' }))
    await events.type(messageBox('bob'), 'this one is pending{Enter}')

    history(BOB, [said(1, 'bob', 'bob', 'from history', 1000)])

    expect(messages()).toEqual(['from history', 'this one fails', 'this one is pending'])
    expect(messageRow('this one fails')).toHaveTextContent('Not sent — Message could not be saved')
    expect(messageRow('this one is pending')).toHaveTextContent('Sending…')
  })
})

describe('a lost acknowledgement', () => {
  // Only the acknowledgement timeout is faked; everything else, including the brief
  // cross-fade of the status line, runs on real time and is awaited.
  const sendWithFakeTimers = async (text: string) => {
    await openChatWithBob()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.change(messageBox('bob'), { target: { value: text } })
    fireEvent.click(sendButton())
    return (fakeSocket.last('sendmessage').payload as SendMessagePayload).clientId
  }
  const eventually = async (text: string, status: string | RegExp) => {
    vi.useRealTimers()
    await waitFor(() => expect(messageRow(text)).toHaveTextContent(status))
  }

  it('marks the message unconfirmed when no acknowledgement arrives in time', async () => {
    await sendWithFakeTimers('are you there?')

    act(() => vi.advanceTimersByTime(9_999))
    // Not yet: the state behind the screen is still "pending" one millisecond early.
    expect(messageRow('are you there?')).toHaveTextContent('Sending…')
    act(() => vi.advanceTimersByTime(1))

    await eventually('are you there?', 'Not sent — Delivery unconfirmed')
    expect(messageRow('are you there?')).not.toHaveTextContent('Sending…')
  })

  it('marks it unconfirmed at once if the connection drops while it is pending', async () => {
    await sendWithFakeTimers('are you there?')

    // No time passes at all: the disconnect alone resolves it.
    disconnect()

    await eventually('are you there?', 'Not sent — Delivery unconfirmed')
    expect(messageRow('are you there?')).not.toHaveTextContent('Sending…')
  })

  it('turns it into one sent message when history shows it was saved after all', async () => {
    const clientId = await sendWithFakeTimers('are you there?')
    disconnect()

    history(BOB, [said(9, 'alice', 'bob', 'are you there?', 9000, clientId)])

    await eventually('are you there?', 'Sent')
    expect(messages()).toEqual(['are you there?'])
    expect(messageRow('are you there?')).not.toHaveTextContent('Not sent')
  })

  it('does not create a second entry when the acknowledgement arrives after history confirmed it', async () => {
    const clientId = await sendWithFakeTimers('are you there?')
    history(BOB, [said(9, 'alice', 'bob', 'are you there?', 9000, clientId)])

    act(() => fakeSocket.last('sendmessage').ack!({ ok: true, id: mid(9), timestamp: 9000 }))

    await eventually('are you there?', 'Sent')
    expect(messages()).toEqual(['are you there?'])
  })

  it('a late timeout does not downgrade a message that has since been confirmed', async () => {
    const clientId = await sendWithFakeTimers('are you there?')
    history(BOB, [said(9, 'alice', 'bob', 'are you there?', 9000, clientId)])

    act(() => vi.advanceTimersByTime(10_000))

    await eventually('are you there?', 'Sent')
    // Give a wrongly-applied failure the chance to show before concluding it did not.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(messageRow('are you there?')).not.toHaveTextContent('Not sent')
    expect(messages()).toEqual(['are you there?'])
  })
})

describe('a message its author deleted', () => {
  const said = (n: number, from: string, text: string, extra: Partial<Message> = {}) =>
    message(from, from === 'alice' ? 'bob' : 'alice', text, { id: n.toString(16).padStart(24, '0'), timestamp: n * 1000, ...extra })

  it('becomes a quiet line where it stood, live and from history, and is not what the chat last said', async () => {
    renderApp()
    const two = said(2, 'bob', 'delete me')
    const events = await loginAs('alice', [user('bob')], [conversation('alice', 'bob', { last: two, unreadCount: 2 })])
    expect(chatButton('bob')).toHaveTextContent('delete me')
    await events.click(chatButton('bob'))
    serverSays('history', { conversationId: BOB, messages: [said(1, 'bob', 'keep me'), two, { ...said(3, 'alice', ''), kind: 'deleted', text: null }], hasMore: false })
    expect(messages()).toEqual(['keep me', 'delete me', 'You deleted a message'])

    serverSays('messageDeleted', { conversationId: BOB, id: two.id })
    await waitFor(() => expect(messages()).toEqual(['keep me', 'bob deleted a message', 'You deleted a message']))
    expect(screen.queryByText('delete me')).not.toBeInTheDocument()
    // One that is not held, or already gone, changes nothing.
    serverSays('messageDeleted', { conversationId: BOB, id: two.id })
    serverSays('messageDeleted', { conversationId: 'dm:nobody::nothing', id: two.id })
    expect(messages()).toHaveLength(3)

    // The server's word on the conversation follows: no words of the deleted message in the list.
    const last = { id: two.id, from: idOf('bob'), fromName: 'bob', preview: '', timestamp: two.timestamp, kind: 'deleted' as const }
    serverSays('conversationUpdated', { conversation: { ...conversation('alice', 'bob'), lastMessage: last } })
    expect(chatButton('bob')).toHaveTextContent('Message deleted')
    expect(chatButton('bob')).not.toHaveTextContent('delete me')
  })
})

describe('a message with files', () => {
  it('is named by its files where there are no words: in the list and, for now, in the conversation', async () => {
    renderApp()
    const file = { id: '3f0e6c1a-0000-4000-8000-000000000001', name: 'holiday.png', type: 'image/png', size: 2048 }
    const sent = message('bob', 'alice', '', { id: '0'.repeat(23) + '1', timestamp: 1000, attachments: [file, { ...file, id: file.id.replace(/1$/, '2'), name: 'notes.pdf' }] })
    const events = await loginAs('alice', [user('bob')], [{
      ...conversation('alice', 'bob', { last: sent }),
      lastMessage: { id: sent.id, from: sent.from, fromName: 'bob', preview: '', timestamp: 1000, attachments: 2 },
    }])
    expect(chatButton('bob')).toHaveTextContent('2 files')

    await events.click(chatButton('bob'))
    serverSays('history', { conversationId: BOB, messages: [sent], hasMore: false })
    expect(screen.getByRole('log')).toHaveTextContent('holiday.png')
    expect(screen.getByRole('log')).toHaveTextContent('notes.pdf')

    // One that arrives live is counted, and previewed, the same way.
    serverSays('message', message('bob', 'alice', '', { attachments: [file] }))
    await waitFor(() => expect(chatButton('bob')).toHaveTextContent('1 file'))
  })
})
