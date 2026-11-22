import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTCOME_SHOWN_MS, REJOIN_AGAIN_MS, REJOIN_FOR_MS } from '@/hooks/useCall'
import { callLength, describeCall } from '@/lib/callEvents'
import { FakeMediaStream, FakePeerConnection, track } from '@/test/fakeWebRTC'
import {
  chatButton, connectAs, conversation, disconnect, dm, fakeSocket, idOf, loggedInPayload, loginAs, message, messages, personButton,
  renderApp, serverSays, user,
} from '@/test/harness'
import type { CallRecord, ConversationSummary, Message } from '@/types/protocol'

// Calls: the line one leaves in its conversation, and making, taking and ending one —
// with the server played by the tests and the browser's own part (camera, microphone,
// the connection to the other browser) by stand-ins.

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

  it('counts as unread when it arrives only if the user missed it, and reads the other way round to the one who called', async () => {
    renderApp()
    await loginAs('alice', [user('bob'), user('carol')], [conversation('alice', 'carol')])
    await userEvent.click(chatButton('carol'))

    // One that alice made, told to this device by the server like any message of hers; and one she took part in.
    serverSays('message', called(3, 'alice', 'bob', { media: 'audio', outcome: 'declined', durationMs: 0 }))
    serverSays('message', called(4, 'bob', 'alice', { media: 'audio', outcome: 'ended', durationMs: 125_000 }))

    expect(await screen.findByText('Voice call · 2 min')).toBeInTheDocument()
    expect(chatButton('bob')).toHaveTextContent('Voice call · 2 min')
    expect(chatButton('bob')).not.toHaveTextContent(/unread/i)

    // One she never got to answer is news to her.
    serverSays('message', called(5, 'bob', 'alice', { media: 'video', outcome: 'cancelled', durationMs: 0 }))
    expect(chatButton('bob')).toHaveTextContent('Missed video call')
    expect(chatButton('bob')).toHaveTextContent('1 unread')
  })
})

// ---------- making and taking calls

const BOB = { userId: idOf('bob'), username: 'bob' }
const answer = (event: string, response: object) => act(() => fakeSocket.last(event).ack?.(response))
const sent = (event: string) => fakeSocket.sent<Record<string, unknown>>(event)
const callView = () => screen.queryByRole('region', { name: 'Call with bob' })
const ringing = () => screen.queryByRole('dialog', { name: 'bob is calling' })
const alertText = () => screen.queryByRole('alert')?.textContent ?? null
const button = (name: string | RegExp) => screen.getByRole('button', { name })

/** What the made-up browser hands out when asked for the microphone and camera. */
let opened: FakeMediaStream[]
const getUserMedia = vi.fn<(constraints: { audio?: boolean; video?: boolean }) => Promise<FakeMediaStream>>()
const denied = (name: string) => Object.assign(new Error(name), { name })

/** Alice, on a server that sets up calls, with bob's conversation open. */
const withBob = async ({ calls = true, bob = user('bob') } = {}) => {
  renderApp()
  const events = await loginAs('alice', [bob])
  disconnect()
  connectAs('socket-2')
  serverSays('loggedin', { ...loggedInPayload('alice', [bob], 'token-2'), features: { files: false, ...(calls ? { calls: true } : {}) } })
  await events.click(personButton('bob'))
  return events
}

/** A call alice made that bob accepted, with the connection to his browser set up. */
const callUnderWay = async (media: 'audio' | 'video' = 'video') => {
  const events = await withBob()
  await events.click(button(media === 'video' ? 'Video call' : 'Voice call'))
  await waitFor(() => expect(sent('call:invite')).toHaveLength(1))
  await answer('call:invite', { ok: true, callId: 'call-1', secret: 'secret-1' })
  serverSays('call:accepted', { callId: 'call-1' })
  await waitFor(() => expect(sent('call:config')).toHaveLength(1))
  await answer('call:config', { ok: true, iceServers: [{ urls: ['stun:stun.test:3478'] }] })
  return { events, connection: FakePeerConnection.last() }
}

describe('calling', () => {
  beforeEach(() => {
    opened = []
    FakePeerConnection.all = []
    getUserMedia.mockReset().mockImplementation(async ({ audio, video }) => {
      const stream = new FakeMediaStream([...(audio ? [track('audio')] : []), ...(video ? [track('video')] : [])])
      opened.push(stream)
      return stream
    })
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal('MediaStream', FakeMediaStream)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  })
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices')
  })
  const allStopped = () => opened.every(stream => stream.getTracks().every(made => made.readyState === 'ended'))

  describe('the buttons', () => {
    it('are not there on a server that does not set up calls', async () => {
      await withBob({ calls: false })
      expect(screen.queryByRole('button', { name: /call/i })).not.toBeInTheDocument()
    })

    it('are there for a person, not for a group', async () => {
      await withBob()
      expect(button('Voice call')).toBeEnabled()
      expect(button('Video call')).toBeEnabled()
    })

    it('say why someone cannot be called: not to be disturbed, offline, or the user not connected', async () => {
      await withBob()

      serverSays('presence', { userId: BOB.userId, status: 'dnd', statusText: '' })
      expect(button('Video call — bob has asked not to be disturbed')).toBeDisabled()
      expect(button('Voice call — bob has asked not to be disturbed')).toHaveAttribute('title', 'bob has asked not to be disturbed')

      serverSays('userLeft', { userId: BOB.userId })
      expect(button('Video call — bob is offline')).toBeDisabled()

      disconnect()
      expect(button('Video call — You are not connected')).toBeDisabled()
    })

    it('say so in a browser that cannot make calls', async () => {
      vi.stubGlobal('RTCPeerConnection', undefined)
      await withBob()
      expect(button('Video call — Calls are not supported in this browser')).toBeDisabled()
    })
  })

  describe('someone', () => {
    it('opens the microphone and camera, rings them, and connects when they accept', async () => {
      const events = await withBob()

      await events.click(button('Video call'))

      expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true })
      await waitFor(() => expect(sent('call:invite')).toEqual([{ to: BOB.userId, media: 'video' }]))
      expect(callView()).toHaveTextContent('Calling…')
      await answer('call:invite', { ok: true, callId: 'call-1', secret: 'secret-1' })
      expect(callView()).toHaveTextContent('Ringing…')
      // Nobody else can be called meanwhile.
      expect(button('Voice call — You are already in a call')).toBeDisabled()
      // Nothing is set up with the other browser until there is one.
      expect(sent('call:config')).toEqual([])

      serverSays('call:accepted', { callId: 'call-1' })
      expect(callView()).toHaveTextContent('Connecting…')
      await waitFor(() => expect(sent('call:config')).toEqual([{ callId: 'call-1' }]))
      await answer('call:config', { ok: true, iceServers: [{ urls: ['turn:relay.test'], username: 'u', credential: 'c' }] })

      const connection = FakePeerConnection.last()
      expect(connection.configuration).toEqual({ iceServers: [{ urls: ['turn:relay.test'], username: 'u', credential: 'c' }] })
      expect(connection.senders.map(sender => sender.track?.kind)).toEqual(['audio', 'video'])
      // What this browser proposes goes to the other through the server, and what the other says comes back.
      await act(() => connection.negotiate())
      expect(sent('call:signal')).toEqual([{ callId: 'call-1', description: { type: 'offer', sdp: 'offer-1' } }])
      serverSays('call:signal', { callId: 'call-1', description: { type: 'answer', sdp: 'theirs' } })
      await waitFor(() => expect(connection.remote).toEqual([{ type: 'answer', sdp: 'theirs' }]))

      act(() => connection.become('connected'))
      expect(callView()).toHaveAttribute('data-call', 'active')
      expect(screen.getByRole('timer')).toHaveTextContent('0:00')
      // The secret is this device's alone: it is on no screen and in no storage.
      expect(document.body.textContent).not.toContain('secret-1')
      expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain('secret-1')
    })

    it('who cannot be rung is said why, and nothing is left open', async () => {
      const events = await withBob()
      await events.click(button('Voice call'))
      await waitFor(() => expect(sent('call:invite')).toEqual([{ to: BOB.userId, media: 'audio' }]))

      await answer('call:invite', { ok: false, message: 'They are in another call', reason: 'busy' })

      await waitFor(() => expect(callView()).not.toBeInTheDocument())
      expect(alertText()).toContain('bob is in another call')
      expect(allStopped()).toBe(true)
      await events.click(button('Close'))
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
      // And they can be tried again.
      expect(button('Voice call')).toBeEnabled()
    })

    it.each([
      ['unavailable', 'bob cannot be reached right now'],
      ['dnd', 'bob has asked not to be disturbed'],
      ['in-call', 'You are already in a call on another device'],
      [undefined, 'Too many requests, slow down'],
    ])('who cannot be rung (%s) is said so in words', async (reason, words) => {
      const events = await withBob()
      await events.click(button('Voice call'))
      await waitFor(() => expect(sent('call:invite')).toHaveLength(1))
      await answer('call:invite', { ok: false, message: 'Too many requests, slow down', ...(reason ? { reason } : {}) })
      expect(alertText()).toContain(words)
    })

    it('says why a call ended for a moment, then gets out of the way', async () => {
      const events = await withBob()
      await events.click(button('Voice call'))
      await waitFor(() => expect(sent('call:invite')).toHaveLength(1))
      await answer('call:invite', { ok: true, callId: 'call-1', secret: 'secret-1' })
      vi.useFakeTimers()

      serverSays('call:ended', { callId: 'call-1', reason: 'declined' })
      expect(alertText()).toContain('bob declined the call')
      expect(allStopped()).toBe(true)

      act(() => void vi.advanceTimersByTime(OUTCOME_SHOWN_MS))
      vi.useRealTimers()
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    })

    it('does not ring anyone if the browser may not use the microphone — and that stays said until closed', async () => {
      getUserMedia.mockRejectedValue(denied('NotAllowedError'))
      const events = await withBob()
      vi.useFakeTimers({ shouldAdvanceTime: true })

      await events.click(button('Video call'))

      await waitFor(() => expect(alertText()).toContain('not allowed to use the microphone or camera'))
      expect(sent('call:invite')).toEqual([])
      act(() => void vi.advanceTimersByTime(OUTCOME_SHOWN_MS * 3))
      expect(alertText()).toContain('not allowed')
    })

    it('calls without picture from a device that has a microphone and no camera', async () => {
      getUserMedia.mockImplementation(async ({ video }) => {
        if (video) throw denied('NotFoundError')
        const stream = new FakeMediaStream([track('audio')])
        opened.push(stream)
        return stream
      })
      const events = await withBob()

      await events.click(button('Video call'))

      await waitFor(() => expect(sent('call:invite')).toEqual([{ to: BOB.userId, media: 'video' }]))
      expect(button('Turn the camera on')).toBeInTheDocument()
    })

    it('says there is no microphone where there is none', async () => {
      getUserMedia.mockRejectedValue(denied('NotFoundError'))
      const events = await withBob()
      await events.click(button('Voice call'))
      await waitFor(() => expect(alertText()).toContain('No microphone was found'))
      expect(sent('call:invite')).toEqual([])
    })

    it('can be cancelled before the server has even answered: the call is ended as soon as it has a name', async () => {
      const events = await withBob()
      await events.click(button('Voice call'))
      await waitFor(() => expect(sent('call:invite')).toHaveLength(1))

      await events.click(button('Cancel the call'))
      await waitFor(() => expect(callView()).not.toBeInTheDocument())
      expect(allStopped()).toBe(true)
      expect(sent('call:end')).toEqual([])

      await answer('call:invite', { ok: true, callId: 'call-1', secret: 'secret-1' })
      expect(sent('call:end')).toEqual([{ callId: 'call-1' }])
      await waitFor(() => expect(callView()).not.toBeInTheDocument())
    })
  })

  describe('being called', () => {
    const incoming = (media: 'audio' | 'video' = 'video') =>
      serverSays('call:incoming', { callId: 'call-2', conversationId: dm('alice', 'bob'), media, from: BOB })

    it('asks what to do, and says so in the tab’s title', async () => {
      await withBob()
      const title = document.title

      incoming()

      expect(ringing()).toHaveTextContent('Video call')
      expect(document.title).toBe('bob is calling…')
      // Nothing is opened, and nothing sent, until the user decides.
      expect(getUserMedia).not.toHaveBeenCalled()

      serverSays('call:ended', { callId: 'call-2', reason: 'missed' })
      expect(ringing()).not.toBeInTheDocument()
      expect(document.title).toBe(title)
      // The conversation will say it was missed: nothing more is said here.
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    })

    it('offers a voice call one way to accept, a video call two', async () => {
      await withBob()
      incoming('audio')
      expect(button('Accept')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Accept with video' })).not.toBeInTheDocument()
    })

    it('is not declined by the page being left: it goes on ringing on the user’s other devices', async () => {
      const beacon = vi.fn(() => true)
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon })
      await withBob()
      incoming()

      act(() => void window.dispatchEvent(new PageTransitionEvent('pagehide')))
      Reflect.deleteProperty(navigator, 'sendBeacon')

      expect(beacon).not.toHaveBeenCalled()
      expect(sent('call:end')).toEqual([])
    })

    it('can be declined', async () => {
      const events = await withBob()
      incoming()

      await events.click(button('Decline'))

      expect(sent('call:end')).toEqual([{ callId: 'call-2' }])
      expect(ringing()).not.toBeInTheDocument()
      expect(getUserMedia).not.toHaveBeenCalled()
    })

    it('can be accepted without picture; what the caller’s browser said meanwhile is not lost', async () => {
      const events = await withBob()
      incoming()

      await events.click(button('Accept with voice only'))

      expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false })
      await waitFor(() => expect(sent('call:accept')).toEqual([{ callId: 'call-2' }]))
      expect(callView()).toHaveTextContent('Connecting…')
      await answer('call:accept', { ok: true, secret: 'secret-2' })
      await waitFor(() => expect(sent('call:config')).toEqual([{ callId: 'call-2' }]))
      // The caller's offer arrives before this browser has anything to give it to.
      serverSays('call:signal', { callId: 'call-2', description: { type: 'offer', sdp: 'theirs' } })
      serverSays('call:signal', { callId: 'call-2', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null } })
      await answer('call:config', { ok: true, iceServers: [] })

      const connection = FakePeerConnection.last()
      await waitFor(() => expect(connection.remote).toEqual([{ type: 'offer', sdp: 'theirs' }]))
      await waitFor(() => expect(connection.candidates).toHaveLength(1))
      await waitFor(() => expect(sent('call:signal')).toEqual([{ callId: 'call-2', description: { type: 'answer', sdp: 'answer-1' } }]))
      expect(connection.senders.map(sender => sender.track?.kind)).toEqual(['audio'])
    })

    it('says nothing when another of the user’s devices took it', async () => {
      const events = await withBob()
      incoming()
      await events.click(button('Accept with video'))
      await waitFor(() => expect(sent('call:accept')).toHaveLength(1))

      await answer('call:accept', { ok: false, message: 'Answered on another device', reason: 'answered-elsewhere' })

      await waitFor(() => expect(callView()).not.toBeInTheDocument())
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
      expect(allStopped()).toBe(true)
    })

    it('says so if the microphone cannot be used after all — without declining: another device of theirs may yet answer', async () => {
      getUserMedia.mockRejectedValue(denied('NotAllowedError'))
      const events = await withBob()
      incoming('audio')

      await events.click(button('Accept'))

      await waitFor(() => expect(alertText()).toContain('not allowed to use the microphone or camera'))
      expect(ringing()).not.toBeInTheDocument()
      expect(sent('call:decline')).toEqual([])
      expect(sent('call:end')).toEqual([])
      expect(sent('call:accept')).toEqual([])
    })

    it('rings on a device that is signed in while the call is being made: the server says so at once, before the chat is on screen', async () => {
      renderApp()
      const events = userEvent.setup()
      await events.type(screen.getByLabelText('Username'), 'alice')
      await events.click(screen.getByRole('button', { name: 'Join' }))

      // In one go, as they arrive.
      act(() => {
        fakeSocket.trigger('loggedin', { ...loggedInPayload('alice', [user('bob')], 'token-1'), features: { files: false, calls: true } })
        fakeSocket.trigger('call:incoming', { callId: 'call-2', conversationId: dm('alice', 'bob'), media: 'video', from: BOB })
      })

      await waitFor(() => expect(ringing()).toBeInTheDocument())
      expect(document.title).toBe('bob is calling…')
      serverSays('call:ended', { callId: 'call-2', reason: 'cancelled' })
    })

    it('takes the place of a call of the user’s own that had not got as far as the server', async () => {
      let allow: (stream: FakeMediaStream) => void = () => {}
      getUserMedia.mockImplementationOnce(() => new Promise(resolve => { allow = resolve }))
      const events = await withBob()
      // The browser is asking about the microphone…
      await events.click(button('Voice call'))
      expect(callView()).toHaveTextContent('Calling…')

      // …when bob calls. The server would refuse alice's call now: his is the one that is real.
      incoming('audio')

      expect(ringing()).toBeInTheDocument()
      await waitFor(() => expect(callView()).not.toBeInTheDocument())
      // The microphone, allowed after all, is let go; nobody is rung.
      const late = new FakeMediaStream([track('audio')])
      await act(async () => allow(late))
      expect(late.getTracks()[0].readyState).toBe('ended')
      expect(sent('call:invite')).toEqual([])
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      // And it can be answered like any other.
      await events.click(button('Accept'))
      await waitFor(() => expect(sent('call:accept')).toEqual([{ callId: 'call-2' }]))
    })

    it('stops ringing if the connection to the server goes: it will ring again if it is still being made', async () => {
      await withBob()
      incoming()

      disconnect()

      expect(ringing()).not.toBeInTheDocument()
    })

    it('does not interrupt a call that is under way', async () => {
      await callUnderWay()
      serverSays('call:incoming', { callId: 'call-9', conversationId: dm('alice', 'bob'), media: 'audio', from: BOB })
      expect(ringing()).not.toBeInTheDocument()
      expect(callView()).toBeInTheDocument()
    })
  })

  describe('a call under way', () => {
    it('can be muted, have its camera turned off, and be shrunk to a corner and brought back', async () => {
      const { events } = await callUnderWay()
      const [voice] = opened[0].getAudioTracks()
      const [picture] = opened[0].getVideoTracks()

      await events.click(button('Mute the microphone'))
      expect(voice.enabled).toBe(false)
      await events.click(button('Unmute the microphone'))
      expect(voice.enabled).toBe(true)

      await events.click(button('Turn the camera off'))
      expect(picture.enabled).toBe(false)
      expect(button('Turn the camera on')).toHaveAttribute('aria-pressed', 'true')

      await events.click(button('Minimise the call'))
      expect(screen.queryByRole('button', { name: 'Unmute the microphone' })).not.toBeInTheDocument()
      expect(button('Hang up')).toBeInTheDocument()
      await events.click(button('Back to the call'))
      expect(button('Mute the microphone')).toBeInTheDocument()
    })

    it('opens the camera when it is turned on in a call that began without one', async () => {
      const { events, connection } = await callUnderWay('audio')
      expect(connection.senders.map(sender => sender.track?.kind)).toEqual(['audio'])

      await events.click(button('Turn the camera on'))

      await waitFor(() => expect(connection.senders.map(sender => sender.track?.kind)).toEqual(['audio', 'video']))
      expect(getUserMedia).toHaveBeenLastCalledWith({ video: true })
      expect(button('Turn the camera off')).toBeInTheDocument()
    })

    it('says it is reconnecting while the two browsers have lost each other, without starting the clock again', async () => {
      const { connection } = await callUnderWay()
      act(() => connection.become('connected'))

      act(() => connection.become('disconnected'))
      expect(callView()).toHaveTextContent('Reconnecting…')
      act(() => connection.become('connected'))
      expect(screen.getByRole('timer')).toBeInTheDocument()

      serverSays('call:peer', { callId: 'call-1', connected: false })
      expect(callView()).toHaveTextContent('Reconnecting…')
      serverSays('call:peer', { callId: 'call-1', connected: true })
      expect(callView()).not.toHaveTextContent('Reconnecting…')
    })

    it('is hung up: the server is told, and the camera and microphone are let go', async () => {
      const { events, connection } = await callUnderWay()

      await events.click(button('Hang up'))

      expect(sent('call:end')).toEqual([{ callId: 'call-1' }])
      await waitFor(() => expect(callView()).not.toBeInTheDocument())
      expect(connection.closed).toBe(true)
      expect(allStopped()).toBe(true)
      // The user did it: there is nothing to tell them. And what the server then says of it changes nothing.
      serverSays('call:ended', { callId: 'call-1', reason: 'ended' })
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    })

    it('ends when the other person hangs up, or the server cuts it off', async () => {
      const { connection } = await callUnderWay()

      serverSays('call:ended', { callId: 'call-1', reason: 'failed' })

      await waitFor(() => expect(callView()).not.toBeInTheDocument())
      expect(alertText()).toContain('The call was cut off')
      expect(connection.closed).toBe(true)
      expect(allStopped()).toBe(true)
    })

    it('is hung up when the page is left, before the connection is closed — and by a beacon, which a browser delivers even then', async () => {
      const beacon = vi.fn(() => true)
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon })
      await callUnderWay()

      act(() => void window.dispatchEvent(new PageTransitionEvent('pagehide')))
      Reflect.deleteProperty(navigator, 'sendBeacon')

      expect(beacon).toHaveBeenCalledTimes(1)
      const [url, body] = beacon.mock.calls[0] as unknown as [string, string]
      expect(url).toMatch(/\/call\/leave$/)
      expect(JSON.parse(body)).toEqual({ callId: 'call-1', secret: 'secret-1' })

      const order = [...fakeSocket.emit.mock.calls.map(([event]) => event)]
      expect(order.at(-1)).toBe('call:end')
      expect(fakeSocket.emit.mock.calls.at(-1)?.[1]).toEqual({ callId: 'call-1' })
      expect(fakeSocket.disconnect).toHaveBeenCalled()
      expect(fakeSocket.emit.mock.invocationCallOrder.at(-1)).toBeLessThan(fakeSocket.disconnect.mock.invocationCallOrder.at(-1) ?? 0)
    })

    it('gives up, and says so, if the two browsers never reach each other', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      await callUnderWay()

      act(() => void vi.advanceTimersByTime(30_000))

      await waitFor(() => expect(alertText()).toContain('Could not connect to bob'))
      expect(sent('call:end')).toEqual([{ callId: 'call-1' }])
      expect(allStopped()).toBe(true)
    })

    it('is taken back, with this device’s secret, after the connection to the server was lost', async () => {
      const { connection } = await callUnderWay()
      act(() => connection.become('connected'))

      disconnect()
      // Still the call, as far as anyone here knows: the other side is given a while to see it come back.
      expect(callView()).toBeInTheDocument()
      connectAs('socket-3')
      serverSays('loggedin', { ...loggedInPayload('alice', [user('bob')], 'token-3'), features: { files: false, calls: true } })

      await waitFor(() => expect(sent('call:rejoin')).toEqual([{ callId: 'call-1', secret: 'secret-1' }]))
      await answer('call:rejoin', { ok: true, state: 'active', media: 'video', peerConnected: true })
      // A new path is looked for: the old one went with the old network.
      expect(connection.restarts).toBe(1)
      expect(callView()).toBeInTheDocument()
    })

    it('goes on asking for the call back while the server does not answer, and gives it up when the server would have', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      await callUnderWay()
      disconnect()
      connectAs('socket-3')
      serverSays('loggedin', { ...loggedInPayload('alice', [user('bob')], 'token-3'), features: { files: false, calls: true } })
      await waitFor(() => expect(sent('call:rejoin')).toHaveLength(1))

      // No answer in time (the request layer's own words for it), twice; then one.
      await answer('call:rejoin', { ok: false, message: 'No answer', retryable: true })
      await act(() => vi.advanceTimersByTimeAsync(REJOIN_AGAIN_MS))
      expect(sent('call:rejoin')).toHaveLength(2)
      expect(callView()).toBeInTheDocument()

      // Still none by the time the server has ended the call: this device was not told, and says so itself.
      await act(() => vi.advanceTimersByTimeAsync(REJOIN_FOR_MS))
      await answer('call:rejoin', { ok: false, message: 'No answer', retryable: true })

      await waitFor(() => expect(callView()).not.toBeInTheDocument())
      expect(alertText()).toContain('The call was cut off')
      expect(allStopped()).toBe(true)
      const asked = sent('call:rejoin').length
      await act(() => vi.advanceTimersByTimeAsync(REJOIN_AGAIN_MS * 3))
      expect(sent('call:rejoin')).toHaveLength(asked)
    })

    it('is over, with nothing more to say, when the user leaves — the server ends it and does not tell a page that is nobody', async () => {
      const { events, connection } = await callUnderWay()
      await events.click(button('Minimise the call'))

      await events.click(screen.getByRole('button', { name: 'Account menu for alice' }))
      await events.click(await screen.findByRole('menuitem', { name: 'Leave' }))
      await answer('logout', { ok: true })

      await screen.findByLabelText('Username')
      expect(callView()).not.toBeInTheDocument()
      expect(connection.closed).toBe(true)
      expect(allStopped()).toBe(true)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('is over when this tab is put aside by another, or signed out from elsewhere', async () => {
      const { connection } = await callUnderWay()

      serverSays('sessionRevoked', { reason: 'Signed out from another device' })
      disconnect('io server disconnect')

      await waitFor(() => expect(connection.closed).toBe(true))
      expect(allStopped()).toBe(true)
      expect(callView()).not.toBeInTheDocument()
    })

    it('opens one camera, however many times the button is pressed while it opens', async () => {
      const { connection } = await callUnderWay('audio')
      let allow: (stream: FakeMediaStream) => void = () => {}
      getUserMedia.mockImplementationOnce(() => new Promise(resolve => { allow = resolve }))

      const camera = button('Turn the camera on')
      await act(async () => {
        camera.click()
        camera.click()
      })
      const stream = new FakeMediaStream([track('video')])
      opened.push(stream)
      await act(async () => allow(stream))

      await waitFor(() => expect(button('Turn the camera off')).toBeInTheDocument())
      expect(getUserMedia).toHaveBeenCalledTimes(2)
      expect(connection.senders.map(sender => sender.track)).toEqual([opened[0].getAudioTracks()[0], stream.getVideoTracks()[0]])
      expect(stream.getVideoTracks()[0].enabled).toBe(true)
    })

    it('looks for a path through the server anyone may use if this one did not say which to use', async () => {
      const events = await withBob()
      await events.click(button('Voice call'))
      await waitFor(() => expect(sent('call:invite')).toHaveLength(1))
      await answer('call:invite', { ok: true, callId: 'call-1', secret: 'secret-1' })
      serverSays('call:accepted', { callId: 'call-1' })
      await waitFor(() => expect(sent('call:config')).toHaveLength(1))

      await answer('call:config', { ok: false, message: 'Too many requests, slow down' })

      expect(FakePeerConnection.last().configuration).toEqual({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] })
    })

    it('is over if the server no longer knows it by then', async () => {
      await callUnderWay()
      disconnect()
      connectAs('socket-3')
      serverSays('loggedin', { ...loggedInPayload('alice', [user('bob')], 'token-3'), features: { files: false, calls: true } })
      await waitFor(() => expect(sent('call:rejoin')).toHaveLength(1))

      await answer('call:rejoin', { ok: false, message: 'Unknown call' })

      await waitFor(() => expect(callView()).not.toBeInTheDocument())
      expect(alertText()).toContain('The call was cut off')
      expect(allStopped()).toBe(true)
    })

    it('looks for a new path when the other device comes back, and when this one joins a network', async () => {
      const { connection } = await callUnderWay()
      act(() => connection.become('connected'))

      serverSays('call:peer', { callId: 'call-1', connected: false })
      expect(connection.restarts).toBe(0)
      serverSays('call:peer', { callId: 'call-1', connected: true })
      expect(connection.restarts).toBe(1)
      // (Of another call: nothing.)
      serverSays('call:peer', { callId: 'call-9', connected: true })
      expect(connection.restarts).toBe(1)

      act(() => void window.dispatchEvent(new Event('online')))
      expect(connection.restarts).toBe(2)
    })

    it('shows the other person’s avatar, not a black picture, once they say their camera is off', async () => {
      const { connection } = await callUnderWay()
      act(() => {
        connection.ontrack?.({ track: track('video') })
        connection.become('connected')
      })
      const theirs = () => screen.getByLabelText('bob’s video')
      expect(theirs()).not.toHaveClass('invisible')
      const [channel] = connection.channels
      // They were told what this side sends, too.
      act(() => channel.open())
      expect(channel.sent.map(said => JSON.parse(said))).toEqual([{ picture: 'camera' }])

      act(() => channel.receive(JSON.stringify({ picture: 'none' })))
      expect(theirs()).toHaveClass('invisible')
      act(() => channel.receive(JSON.stringify({ picture: 'screen' })))
      expect(theirs()).not.toHaveClass('invisible')

      await userEvent.click(button('Turn the camera off'))
      expect(JSON.parse(channel.sent.at(-1) ?? '')).toEqual({ picture: 'none' })
    })

    describe('sharing the screen', () => {
      let display: FakeMediaStream
      const getDisplayMedia = vi.fn<() => Promise<FakeMediaStream>>()
      beforeEach(() => {
        display = new FakeMediaStream([track('video')])
        getDisplayMedia.mockReset().mockImplementation(async () => display)
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia, getDisplayMedia } })
      })
      const sending = (connection: FakePeerConnection) => connection.senders.map(sender => sender.track)

      it('is offered once the call is connected, in a browser that can', async () => {
        const { connection } = await callUnderWay()
        expect(screen.queryByRole('button', { name: 'Share your screen' })).not.toBeInTheDocument()
        act(() => connection.become('connected'))
        expect(button('Share your screen')).toBeInTheDocument()
      })

      it('sends the screen in place of the camera, says so to both, and puts the camera back afterwards', async () => {
        const { events, connection } = await callUnderWay()
        act(() => connection.become('connected'))
        const [channel] = connection.channels
        act(() => channel.open())
        const [voice, camera] = opened[0].getTracks()
        const [shared] = display.getTracks()

        await events.click(button('Share your screen'))

        await waitFor(() => expect(sending(connection)).toEqual([voice, shared]))
        expect(callView()).toHaveTextContent('You are sharing your screen')
        expect(JSON.parse(channel.sent.at(-1) ?? '')).toEqual({ picture: 'screen' })
        // The camera is neither sent nor to be fiddled with meanwhile; it is still on.
        expect(button('Turn the camera off')).toBeDisabled()
        expect(camera.readyState).toBe('live')

        await events.click(button('Stop sharing your screen'))

        await waitFor(() => expect(sending(connection)).toEqual([voice, camera]))
        expect(shared.readyState).toBe('ended')
        expect(callView()).not.toHaveTextContent('You are sharing your screen')
        expect(JSON.parse(channel.sent.at(-1) ?? '')).toEqual({ picture: 'camera' })
        expect(button('Turn the camera off')).toBeEnabled()
        // Nothing was agreed anew for any of it.
        expect(sent('call:signal')).toEqual([])
      })

      it('stops when the browser’s own “stop sharing” is pressed; in a voice call nothing is sent afterwards', async () => {
        const { events, connection } = await callUnderWay('audio')
        act(() => connection.become('connected'))
        const [voice] = opened[0].getTracks()
        const [shared] = display.getTracks()
        await events.click(button('Share your screen'))
        await waitFor(() => expect(sending(connection)).toEqual([voice, shared]))

        act(() => shared.onended?.())

        await waitFor(() => expect(sending(connection)).toEqual([voice, null]))
        expect(button('Share your screen')).toHaveAttribute('aria-pressed', 'false')
        // And the camera can still be turned on, through the same sender.
        await events.click(button('Turn the camera on'))
        await waitFor(() => expect(sending(connection)).toEqual([voice, opened[1].getVideoTracks()[0]]))
      })

      it('changes nothing if the user closes the browser’s question', async () => {
        const { events, connection } = await callUnderWay()
        act(() => connection.become('connected'))
        getDisplayMedia.mockRejectedValueOnce(denied('NotAllowedError'))

        await events.click(button('Share your screen'))

        expect(button('Share your screen')).toHaveAttribute('aria-pressed', 'false')
        expect(sending(connection)).toEqual(opened[0].getTracks())
        expect(callView()).toBeInTheDocument()
      })

      it('is let go with the call', async () => {
        const { events, connection } = await callUnderWay()
        act(() => connection.become('connected'))
        await events.click(button('Share your screen'))
        await waitFor(() => expect(callView()).toHaveTextContent('You are sharing your screen'))

        await events.click(button('Hang up'))

        expect(display.getTracks()[0].readyState).toBe('ended')
        expect(allStopped()).toBe(true)
      })
    })

    describe('choosing devices', () => {
      const LIST = [
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in microphone' },
        { kind: 'audioinput', deviceId: 'mic-2', label: 'Headset' },
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Front camera' },
        { kind: 'videoinput', deviceId: 'cam-2', label: 'Back camera' },
        { kind: 'audiooutput', deviceId: 'out-1', label: 'Speakers' },
        { kind: 'audiooutput', deviceId: 'out-2', label: 'Headphones' },
      ]
      const setSinkId = vi.fn(async (_id: string) => {})
      let changed: (() => void) | undefined
      beforeEach(() => {
        setSinkId.mockClear()
        changed = undefined
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia,
            enumerateDevices: async () => LIST,
            addEventListener: (_: string, listener: () => void) => { changed = listener },
            removeEventListener: () => {},
          },
        })
        Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { configurable: true, value: setSinkId })
      })
      afterEach(() => {
        Reflect.deleteProperty(HTMLMediaElement.prototype, 'setSinkId')
        window.localStorage.removeItem('strive-chat.call-devices')
      })
      const remembered = () => JSON.parse(window.localStorage.getItem('strive-chat.call-devices') ?? '{}')
      const openSettings = async (events: ReturnType<typeof userEvent.setup>) => {
        await events.click(await screen.findByRole('button', { name: 'Microphone, camera and speaker' }))
        return screen.findByRole('combobox', { name: 'Microphone' })
      }

      it('speaks through another microphone at once, still muted if it was, and remembers it', async () => {
        const { events, connection } = await callUnderWay()
        const [oldVoice, camera] = opened[0].getTracks()
        await events.click(button('Mute the microphone'))

        const microphone = await openSettings(events)
        expect([...microphone.querySelectorAll('option')].map(option => option.textContent)).toEqual(['Default', 'Built-in microphone', 'Headset'])
        await events.selectOptions(microphone, 'Headset')

        await waitFor(() => expect(connection.senders[0].track).toBe(opened[1].getAudioTracks()[0]))
        expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-2' } } })
        expect(connection.senders[0].track?.enabled).toBe(false)
        expect(oldVoice.readyState).toBe('ended')
        expect(connection.senders[1].track).toBe(camera)
        expect(remembered()).toEqual({ microphone: 'mic-2' })
        expect(sent('call:signal')).toEqual([])
      })

      it('shows through another camera, letting go of the first before opening the second', async () => {
        const { events, connection } = await callUnderWay()
        const [, oldCamera] = opened[0].getTracks()
        getUserMedia.mockImplementationOnce(async () => {
          expect(oldCamera.readyState).toBe('ended')
          const stream = new FakeMediaStream([track('video', { deviceId: 'cam-2', facingMode: 'environment' })])
          opened.push(stream)
          return stream
        })

        await openSettings(events)
        await events.selectOptions(screen.getByRole('combobox', { name: 'Camera' }), 'Back camera')

        await waitFor(() => expect(connection.senders[1].track).toBe(opened[1].getVideoTracks()[0]))
        expect(getUserMedia).toHaveBeenLastCalledWith({ video: { deviceId: { exact: 'cam-2' } } })
        expect(remembered()).toEqual({ camera: 'cam-2' })
        // A camera looking away from the user is not shown as a mirror would.
        await waitFor(() => expect(screen.getByLabelText('Your video')).not.toHaveClass('-scale-x-100'))
      })

      it('plays through the speaker chosen', async () => {
        const { events } = await callUnderWay()
        await openSettings(events)

        await events.selectOptions(screen.getByRole('combobox', { name: 'Speaker' }), 'Headphones')

        await waitFor(() => expect(setSinkId).toHaveBeenLastCalledWith('out-2'))
        expect(remembered()).toEqual({ speaker: 'out-2' })
      })

      it('begins the next call with what was chosen, if it is still there', async () => {
        window.localStorage.setItem('strive-chat.call-devices', JSON.stringify({ microphone: 'mic-2', camera: 'cam-2' }))
        await callUnderWay()
        expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { ideal: 'mic-2' } }, video: { deviceId: { ideal: 'cam-2' } } })
      })

      it('goes on with whichever microphone there is when the one in use is pulled out', async () => {
        const { connection } = await callUnderWay()
        await waitFor(() => expect(changed).toBeDefined())
        const [voice] = opened[0].getAudioTracks()

        voice.readyState = 'ended'
        act(() => changed?.())

        await waitFor(() => expect(connection.senders[0].track).toBe(opened[1].getAudioTracks()[0]))
        expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true })
      })

      it('offers the other camera on a device held in the hand, and keeps the camera on if there turns out to be none', async () => {
        const matchMedia = window.matchMedia
        window.matchMedia = (query: string) => ({ ...matchMedia(query), matches: query === '(pointer: coarse)' })
        try {
          const { events, connection } = await callUnderWay()
          getUserMedia.mockImplementationOnce(async () => {
            const stream = new FakeMediaStream([track('video', { deviceId: 'cam-2', facingMode: 'environment' })])
            opened.push(stream)
            return stream
          })

          await events.click(await screen.findByRole('button', { name: 'Switch camera' }))

          await waitFor(() => expect(connection.senders[1].track).toBe(opened[1].getVideoTracks()[0]))
          expect(getUserMedia).toHaveBeenLastCalledWith({ video: { facingMode: { exact: 'environment' } } })
          expect(remembered()).toEqual({ camera: 'cam-2' })

          // Back again — and this browser will not say which camera is which: whichever it gives.
          getUserMedia.mockRejectedValueOnce(denied('OverconstrainedError'))
          await events.click(button('Switch camera'))
          await waitFor(() => expect(connection.senders[1].track).toBe(opened[2].getVideoTracks()[0]))
          expect(getUserMedia.mock.calls.slice(-2)).toEqual([[{ video: { facingMode: { exact: 'user' } } }], [{ video: true }]])
        } finally {
          window.matchMedia = matchMedia
        }
      })
    })

    it('says so when the connection is poor, and stops saying so when it is not', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { connection } = await callUnderWay()
      act(() => connection.become('connected'))
      const counted = (received: number, lost: number) => {
        connection.stats = [{ type: 'inbound-rtp', packetsReceived: received, packetsLost: lost }]
      }

      counted(1000, 0)
      await act(() => vi.advanceTimersByTimeAsync(3000))
      counted(2000, 300)
      await act(() => vi.advanceTimersByTimeAsync(3000))
      expect(callView()).not.toHaveTextContent('Poor connection')
      counted(3000, 600)
      await act(() => vi.advanceTimersByTimeAsync(3000))
      expect(callView()).toHaveTextContent('Poor connection')

      counted(4000, 600)
      await act(() => vi.advanceTimersByTimeAsync(3000))
      expect(callView()).not.toHaveTextContent('Poor connection')
    })

    it('learns on coming back that it was accepted meanwhile', async () => {
      const events = await withBob()
      await events.click(button('Voice call'))
      await waitFor(() => expect(sent('call:invite')).toHaveLength(1))
      await answer('call:invite', { ok: true, callId: 'call-1', secret: 'secret-1' })
      disconnect()
      connectAs('socket-3')
      serverSays('loggedin', { ...loggedInPayload('alice', [user('bob')], 'token-3'), features: { files: false, calls: true } })
      await waitFor(() => expect(sent('call:rejoin')).toHaveLength(1))

      await answer('call:rejoin', { ok: true, state: 'active', media: 'audio', peerConnected: true })

      expect(callView()).toHaveTextContent('Connecting…')
      await waitFor(() => expect(sent('call:config')).toEqual([{ callId: 'call-1' }]))
    })
  })
})
