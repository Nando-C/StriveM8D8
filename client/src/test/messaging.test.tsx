import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  disconnect, dm, fakeSocket, idOf, loginAs, message, messageBox, messageRow, messages, personButton, renderApp,
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
