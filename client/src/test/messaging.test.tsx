import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  disconnect, fakeSocket, loginAs, messageBox, messageRow, messages, personButton, renderApp,
  sendButton, serverSays, user,
} from '@/test/harness'
import type { ChatMessage, HistoryMessage, SendMessagePayload } from '@/types/protocol'

const live = (id: string, from: string, text: string, timestamp: number): ChatMessage => ({
  id, from, fromId: `${from}-1`, text, timestamp,
})
const saved = (
  id: string, from: string, to: string, text: string, timestamp: number, clientId: string | null = null,
): HistoryMessage => ({ id, clientId, from, to, text, timestamp })

const openChatWithBob = async () => {
  renderApp()
  const events = await loginAs('alice', [user('bob'), user('carol')])
  await events.click(personButton('bob'))
  return events
}

describe('opening a conversation', () => {
  it('requests its history and shows what comes back, oldest first', async () => {
    await openChatWithBob()

    expect(fakeSocket.sent('getHistory')).toEqual([{ withUsername: 'bob' }])
    expect(screen.getByText('No messages yet')).toBeInTheDocument()

    serverSays('history', {
      withUsername: 'bob',
      messages: [saved('m1', 'bob', 'alice', 'hi', 1000), saved('m2', 'alice', 'bob', 'hello', 2000, 'c2')],
    })

    expect(messages()).toEqual(['hi', 'hello'])
    expect(messageRow('hello')).toHaveTextContent('You:')
    expect(messageRow('hi')).toHaveTextContent('bob:')
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument()
  })

  it('shows a history error in the conversation it belongs to', async () => {
    await openChatWithBob()

    serverSays('historyError', { withUsername: 'bob', message: 'History could not be loaded' })

    expect(screen.getByRole('alert')).toHaveTextContent('History could not be loaded')
  })

  it('files a late history response under the conversation it names, not the one on screen', async () => {
    const events = await openChatWithBob()
    await events.click(personButton('carol'))

    // Bob's history arrives only now, after the switch to Carol.
    serverSays('history', { withUsername: 'bob', messages: [saved('m1', 'bob', 'alice', 'for the bob chat', 1000)] })

    expect(messages()).toEqual([])
    await events.click(personButton('bob'))
    expect(messages()).toEqual(['for the bob chat'])
  })
})

describe('receiving messages', () => {
  it('adds a message from the open conversation exactly once', async () => {
    await openChatWithBob()

    serverSays('message', live('m1', 'bob', 'hello alice', 1000))
    // The same message delivered twice (or again through history) is still one message.
    serverSays('message', live('m1', 'bob', 'hello alice', 1000))
    serverSays('history', { withUsername: 'bob', messages: [saved('m1', 'bob', 'alice', 'hello alice', 1000)] })

    expect(messages()).toEqual(['hello alice'])
  })

  it('keeps messages for a conversation that is not open, counts them, and shows each once when opened', async () => {
    const events = await openChatWithBob()

    serverSays('message', live('c1', 'carol', 'one', 1000))
    serverSays('message', live('c2', 'carol', 'two', 2000))
    serverSays('message', live('c3', 'carol', 'three', 3000))

    expect(messages()).toEqual([])
    expect(personButton('carol')).toHaveTextContent('3 unread messages')
    expect(screen.getByText('New message from carol')).toBeInTheDocument()

    await events.click(personButton('carol'))
    serverSays('history', {
      withUsername: 'carol',
      messages: [
        saved('c1', 'carol', 'alice', 'one', 1000),
        saved('c2', 'carol', 'alice', 'two', 2000),
        saved('c3', 'carol', 'alice', 'three', 3000),
      ],
    })

    expect(messages()).toEqual(['one', 'two', 'three'])
    expect(personButton('carol')).not.toHaveTextContent('unread')
  })

  it('orders merged messages by time, whatever order they arrived in', async () => {
    await openChatWithBob()

    serverSays('message', live('m3', 'bob', 'third', 3000))
    serverSays('history', {
      withUsername: 'bob',
      messages: [saved('m1', 'bob', 'alice', 'first', 1000), saved('m2', 'alice', 'bob', 'second', 2000, 'c2')],
    })

    expect(messages()).toEqual(['first', 'second', 'third'])
  })
})

describe('sending messages', () => {
  it('sends to the recipient’s current socket id with a client id, and shows the message as sending', async () => {
    const events = await openChatWithBob()

    await events.type(messageBox('bob'), 'hello bob')
    await events.click(sendButton())

    const payload = fakeSocket.last('sendmessage').payload as SendMessagePayload
    expect(payload).toEqual({ toUserId: 'bob-1', text: 'hello bob', clientId: expect.any(String) })
    expect(payload.clientId).toMatch(/^[A-Za-z0-9-]{1,64}$/)
    expect(messages()).toEqual(['hello bob'])
    expect(messageRow('hello bob')).toHaveTextContent('Sending…')
    expect(messageBox('bob')).toHaveValue('')
  })

  it('uses the id the recipient has now, not the one they had when the chat was opened', async () => {
    const events = await openChatWithBob()

    serverSays('newLogin', user('bob', 'bob-2'))
    await events.type(messageBox('bob'), 'still there?{Enter}')

    expect((fakeSocket.last('sendmessage').payload as SendMessagePayload).toUserId).toBe('bob-2')
  })

  it('marks the message sent when the server acknowledges it', async () => {
    const events = await openChatWithBob()
    await events.type(messageBox('bob'), 'hello bob{Enter}')

    act(() => fakeSocket.last('sendmessage').ack!({ ok: true, id: 'm1', timestamp: 5000 }))

    expect(await screen.findByText('Sent')).toBeInTheDocument()
    expect(messageRow('hello bob')).not.toHaveTextContent('Sending…')
    expect(messages()).toEqual(['hello bob'])
  })

  it('marks the message failed, with the reason, when the server refuses it', async () => {
    const events = await openChatWithBob()
    await events.type(messageBox('bob'), 'hello bob{Enter}')

    act(() => fakeSocket.last('sendmessage').ack!({ ok: false, message: 'Recipient is not online' }))

    expect(await screen.findByText(/Not sent — Recipient is not online/)).toBeInTheDocument()
    expect(messageRow('hello bob')).not.toHaveTextContent('Sent')
  })

  it('cannot send while the recipient is offline', async () => {
    const events = await openChatWithBob()

    serverSays('userLeft', { id: 'bob-1' })

    expect(messageBox('bob')).toBeDisabled()
    expect(sendButton()).toBeDisabled()
    expect(messageBox('bob')).toHaveAttribute('placeholder', 'bob is offline')
    await events.keyboard('{Enter}')
    expect(fakeSocket.sent('sendmessage')).toEqual([])
  })

  it('keeps a pending and a failed message through a history merge, after the confirmed ones', async () => {
    const events = await openChatWithBob()
    await events.type(messageBox('bob'), 'this one fails{Enter}')
    act(() => fakeSocket.last('sendmessage').ack!({ ok: false, message: 'Message could not be saved' }))
    await events.type(messageBox('bob'), 'this one is pending{Enter}')

    serverSays('history', { withUsername: 'bob', messages: [saved('m1', 'bob', 'alice', 'from history', 1000)] })

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

    serverSays('history', {
      withUsername: 'bob',
      messages: [saved('m9', 'alice', 'bob', 'are you there?', 9000, clientId)],
    })

    await eventually('are you there?', 'Sent')
    expect(messages()).toEqual(['are you there?'])
    expect(messageRow('are you there?')).not.toHaveTextContent('Not sent')
  })

  it('does not create a second entry when the acknowledgement arrives after history confirmed it', async () => {
    const clientId = await sendWithFakeTimers('are you there?')
    serverSays('history', {
      withUsername: 'bob',
      messages: [saved('m9', 'alice', 'bob', 'are you there?', 9000, clientId)],
    })

    act(() => fakeSocket.last('sendmessage').ack!({ ok: true, id: 'm9', timestamp: 9000 }))

    await eventually('are you there?', 'Sent')
    expect(messages()).toEqual(['are you there?'])
  })

  it('a late timeout does not downgrade a message that has since been confirmed', async () => {
    const clientId = await sendWithFakeTimers('are you there?')
    serverSays('history', {
      withUsername: 'bob',
      messages: [saved('m9', 'alice', 'bob', 'are you there?', 9000, clientId)],
    })

    act(() => vi.advanceTimersByTime(10_000))

    await eventually('are you there?', 'Sent')
    // Give a wrongly-applied failure the chance to show before concluding it did not.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(messageRow('are you there?')).not.toHaveTextContent('Not sent')
    expect(messages()).toEqual(['are you there?'])
  })
})
