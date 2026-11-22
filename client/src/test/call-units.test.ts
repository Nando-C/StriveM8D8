import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callClock, callOutcomeLine, callReducer, callStatusLine, initialCallState, isEngaged,
  type CallAction, type CallOutcome, type CallPhase, type CallState,
} from '@/lib/call/callState'
import { createPeer, type PeerOptions } from '@/lib/call/peer'
import { FakeMediaStream, FakePeerConnection, track } from '@/test/fakeWebRTC'
import type { CallSignal } from '@/types/protocol'

// The two parts of a call that can be tested without a browser that makes calls: what
// the call is doing (a pure function), and the negotiation between the two ends
// (against a stand-in for the browser's connection).

const BOB = { userId: 'bob-id', username: 'bob' }
const DM = 'alice-id:bob-id'
const run = (...actions: CallAction[]) => actions.reduce(callReducer, initialCallState)

const calling: CallAction = { type: 'calling', peer: BOB, media: 'video', conversationId: DM }
const invited: CallAction = { type: 'invited', callId: 'call-1' }
const accepted: CallAction = { type: 'accepted', callId: 'call-1' }
const connected: CallAction = { type: 'connected', at: 5000 }
const incoming: CallAction = { type: 'incoming', call: { callId: 'call-2', conversationId: DM, media: 'audio', from: BOB } }
const answering: CallAction = { type: 'answering', video: false }

/** A state in each phase, reached the way a call reaches it. */
const IN: Record<CallPhase, CallState> = {
  idle: initialCallState,
  outgoing: run(calling, invited),
  incoming: run(incoming),
  connecting: run(calling, invited, accepted),
  active: run(calling, invited, accepted, connected),
  ended: run(calling, invited, { type: 'ended', callId: 'call-1', reason: 'declined' }),
}
const PHASES = Object.keys(IN) as CallPhase[]

describe('what a call is doing', () => {
  it('goes from calling to ringing to connecting to under way', () => {
    expect(run(calling)).toMatchObject({ phase: 'outgoing', callId: null, peer: BOB, media: 'video', outgoing: true, cameraOn: true, micOn: true })
    expect(IN.outgoing).toMatchObject({ phase: 'outgoing', callId: 'call-1' })
    expect(IN.connecting).toMatchObject({ phase: 'connecting', callId: 'call-1' })
    expect(IN.active).toMatchObject({ phase: 'active', connectedAt: 5000, reconnecting: false })
  })

  it('goes from being rung to connecting when the user accepts, with picture or without', () => {
    expect(IN.incoming).toMatchObject({ phase: 'incoming', callId: 'call-2', peer: BOB, media: 'audio', outgoing: false, cameraOn: false })
    expect(run(incoming, answering)).toMatchObject({ phase: 'connecting', cameraOn: false })
    expect(run(incoming, { type: 'answering', video: true })).toMatchObject({ phase: 'connecting', cameraOn: true })
  })

  // Every action, in every phase: what moves the call on, and what is ignored.
  it.each<[string, CallAction, Partial<Record<CallPhase, CallPhase>>]>([
    ['calling', calling, { idle: 'outgoing', ended: 'outgoing' }],
    ['invited', invited, {}],
    ['incoming', incoming, { idle: 'incoming', ended: 'incoming' }],
    ['answering', answering, { incoming: 'connecting' }],
    ['accepted', accepted, { outgoing: 'connecting' }],
    ['connected', connected, { connecting: 'active' }],
    ['interrupted', { type: 'interrupted' }, {}],
    ['the server ending it', { type: 'ended', callId: 'call-1', reason: 'ended' }, { outgoing: 'ended', connecting: 'ended', active: 'ended' }],
    ['the server ending the one that rings', { type: 'ended', callId: 'call-2', reason: 'missed' }, { incoming: 'idle' }],
    ['failing', { type: 'failed', outcome: 'unreachable' }, { outgoing: 'ended', incoming: 'ended', connecting: 'ended', active: 'ended' }],
    ['hanging up', { type: 'hungUp' }, { outgoing: 'idle', incoming: 'idle', connecting: 'idle', active: 'idle' }],
    ['dismissing', { type: 'dismissed' }, { ended: 'idle' }],
    ['muting', { type: 'micToggled' }, {}],
    ['the camera', { type: 'cameraToggled' }, {}],
    ['minimising', { type: 'minimised', minimised: true }, {}],
    ['the other device going', { type: 'peer', callId: 'call-1', connected: false }, {}],
  ])('%s moves it on only from where it should', (_what, action, moves) => {
    for (const phase of PHASES) {
      const next = callReducer(IN[phase], action)
      expect([phase, next.phase]).toEqual([phase, moves[phase] ?? phase])
      // Whatever does not apply changes nothing at all — the very same state comes back.
      if (['idle', 'ended'].includes(phase) && moves[phase] === undefined) expect(next).toBe(IN[phase])
    }
  })

  it('ignores what is said about another call', () => {
    expect(callReducer(IN.active, { type: 'ended', callId: 'call-9', reason: 'ended' })).toBe(IN.active)
    expect(callReducer(IN.outgoing, { type: 'accepted', callId: 'call-9' })).toBe(IN.outgoing)
    expect(callReducer(IN.active, { type: 'peer', callId: 'call-9', connected: false })).toBe(IN.active)
    // An invitation is named once.
    expect(callReducer(IN.outgoing, { type: 'invited', callId: 'call-9' })).toBe(IN.outgoing)
  })

  it('does not let a second call in while one is under way', () => {
    for (const phase of ['outgoing', 'incoming', 'connecting', 'active'] as const) {
      expect(isEngaged(IN[phase])).toBe(true)
      expect(callReducer(IN[phase], incoming)).toBe(IN[phase])
      expect(callReducer(IN[phase], calling)).toBe(IN[phase])
    }
    expect(isEngaged(IN.idle)).toBe(false)
    expect(isEngaged(IN.ended)).toBe(false)
  })

  it('says why it ended — unless the user did it, or it went on elsewhere', () => {
    expect(IN.ended).toMatchObject({ phase: 'ended', outcome: 'declined', peer: BOB, callId: null })
    expect(callReducer(IN.outgoing, { type: 'ended', callId: 'call-1', reason: 'cancelled' })).toBe(initialCallState)
    expect(callReducer(IN.connecting, { type: 'ended', callId: 'call-1', reason: 'answered-elsewhere' })).toBe(initialCallState)
    expect(callReducer(IN.active, { type: 'failed', outcome: 'refused', message: 'No' })).toMatchObject({ outcome: 'refused', message: 'No' })
  })

  it('keeps track of the microphone, the camera, the size and the connection', () => {
    const muted = callReducer(IN.active, { type: 'micToggled' })
    expect(muted.micOn).toBe(false)
    expect(callReducer(muted, { type: 'micToggled' }).micOn).toBe(true)
    expect(callReducer(IN.active, { type: 'cameraToggled' }).cameraOn).toBe(false)
    expect(callReducer(IN.active, { type: 'cameraUnavailable' }).cameraOn).toBe(false)
    // (Nothing to turn off in a call answered without picture.)
    const voiceOnly = run(incoming, answering)
    expect(callReducer(voiceOnly, { type: 'cameraUnavailable' })).toBe(voiceOnly)
    const small = callReducer(IN.active, { type: 'minimised', minimised: true })
    expect(small.minimised).toBe(true)
    expect(callReducer(small, { type: 'minimised', minimised: true })).toBe(small)

    const interrupted = callReducer(IN.active, { type: 'interrupted' })
    expect(interrupted.reconnecting).toBe(true)
    // Found again: the clock is not started over.
    expect(callReducer(interrupted, { type: 'connected', at: 9000 })).toMatchObject({ reconnecting: false, connectedAt: 5000 })
    const away = callReducer(IN.active, { type: 'peer', callId: 'call-1', connected: false })
    expect(away.peerAway).toBe(true)
    expect(callReducer(away, { type: 'peer', callId: 'call-1', connected: true }).peerAway).toBe(false)
  })

  it('is put into a few words while it lasts', () => {
    expect(callStatusLine(run(calling))).toBe('Calling…')
    expect(callStatusLine(IN.outgoing)).toBe('Ringing…')
    expect(callStatusLine(IN.incoming)).toBe('Incoming voice call')
    expect(callStatusLine(IN.connecting)).toBe('Connecting…')
    expect(callStatusLine(IN.active)).toBe('')
    expect(callStatusLine(callReducer(IN.active, { type: 'interrupted' }))).toBe('Reconnecting…')
    expect(callStatusLine(callReducer(IN.active, { type: 'peer', callId: 'call-1', connected: false }))).toBe('Reconnecting…')
    expect(callStatusLine(IN.idle)).toBe('')
  })

  it.each<[CallOutcome, string]>([
    ['ended', 'Call ended'],
    ['declined', 'bob declined the call'],
    ['missed', 'bob did not answer'],
    ['unavailable', 'bob cannot be reached right now'],
    ['dnd', 'bob has asked not to be disturbed'],
    ['busy', 'bob is in another call'],
    ['in-call', 'You are already in a call on another device'],
    ['failed', 'The call was cut off: the connection was lost'],
    ['unreachable', 'Could not connect to bob. One of your networks may be blocking calls'],
    ['permission', 'Your browser is not allowed to use the microphone or camera. Allow it for this site and call again'],
    ['no-device', 'No microphone was found on this device'],
  ])('says in plain words that it ended: %s', (outcome, line) => {
    expect(callOutcomeLine({ outcome, message: null, peer: BOB })).toBe(line)
  })

  it('uses the server’s own words where it has nothing better', () => {
    expect(callOutcomeLine({ outcome: 'refused', message: 'Too many requests, slow down', peer: BOB })).toBe('Too many requests, slow down')
    expect(callOutcomeLine({ outcome: 'refused', message: null, peer: BOB })).toBe('The call could not be made')
  })

  it.each([[0, '0:00'], [7_900, '0:07'], [754_000, '12:34'], [3_723_000, '1:02:03'], [-5, '0:00']])('shows %i ms as %s', (elapsed, clock) => {
    expect(callClock(elapsed)).toBe(clock)
  })
})

describe('the connection between the two browsers', () => {
  const OFFER = { type: 'offer' as const, sdp: 'their-offer' }
  const ANSWER = { type: 'answer' as const, sdp: 'their-answer' }
  const CANDIDATE = { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' }

  let sent: CallSignal[]
  let streams: FakeMediaStream[]
  let reached: string[]
  const peerWith = (options: Partial<PeerOptions> = {}) => {
    const peer = createPeer({
      polite: false, iceServers: [{ urls: ['stun:stun.test:3478'] }],
      send: signal => sent.push(signal),
      onRemoteStream: stream => streams.push(stream as unknown as FakeMediaStream),
      onConnection: state => reached.push(state),
      ...options,
    })
    return { peer, connection: FakePeerConnection.last() }
  }

  beforeEach(() => {
    sent = []
    streams = []
    reached = []
    FakePeerConnection.all = []
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal('MediaStream', FakeMediaStream)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is made with the servers it was given', () => {
    const { connection } = peerWith()
    expect(connection.configuration).toEqual({ iceServers: [{ urls: ['stun:stun.test:3478'] }] })
  })

  it('proposes what it sends as soon as there is something to send, once per track', async () => {
    const { peer, connection } = peerWith()
    const stream = new FakeMediaStream([track('audio'), track('video')])

    peer.send(stream as unknown as MediaStream)
    peer.send(stream as unknown as MediaStream)

    expect(connection.senders).toHaveLength(2)
    await connection.negotiate()
    expect(sent).toEqual([{ description: { type: 'offer', sdp: 'offer-1' } }])
  })

  it('answers an offer, and takes in an answer and candidates', async () => {
    const { peer, connection } = peerWith({ polite: true })

    await peer.signal({ description: OFFER })
    expect(connection.remote).toEqual([OFFER])
    expect(sent).toEqual([{ description: { type: 'answer', sdp: 'answer-1' } }])

    await peer.signal({ candidate: CANDIDATE })
    expect(connection.candidates).toEqual([CANDIDATE])

    await connection.negotiate()
    expect(sent.at(-1)).toEqual({ description: { type: 'offer', sdp: 'offer-2' } })
    await peer.signal({ description: ANSWER })
    expect(connection.remote).toEqual([OFFER, ANSWER])
    expect(connection.signalingState).toBe('stable')
  })

  it('passes its own candidates on, but not the end of them', () => {
    const { connection } = peerWith()

    connection.onicecandidate?.({ candidate: { ...CANDIDATE, toJSON: () => CANDIDATE, somethingElse: true } })
    connection.onicecandidate?.({ candidate: null })

    expect(sent).toEqual([{ candidate: CANDIDATE }])
  })

  it('when both propose at once, the impolite end keeps its offer and lets the other go — with its candidates', async () => {
    const { peer, connection } = peerWith({ polite: false })
    await connection.negotiate()
    expect(connection.signalingState).toBe('have-local-offer')
    connection.refuseCandidates = true

    await peer.signal({ description: OFFER })
    await peer.signal({ candidate: CANDIDATE })

    expect(connection.remote).toEqual([])
    expect(sent).toEqual([{ description: { type: 'offer', sdp: 'offer-1' } }])
    // Its own offer is still answered.
    await peer.signal({ description: ANSWER })
    expect(connection.remote).toEqual([ANSWER])
  })

  it('lets the other end propose first when it is the polite one: at the start of a call both have something to send', async () => {
    const { peer, connection } = peerWith({ polite: true })
    peer.send(new FakeMediaStream([track('audio')]) as unknown as MediaStream)

    await connection.negotiate()
    expect(sent).toEqual([])
    expect(connection.signalingState).toBe('stable')

    // Its answer to that first offer carries what it sends; after it, it proposes like anyone.
    await peer.signal({ description: OFFER })
    expect(sent).toEqual([{ description: { type: 'answer', sdp: 'answer-1' } }])
    await connection.negotiate()
    expect(sent.at(-1)).toEqual({ description: { type: 'offer', sdp: 'offer-2' } })
  })

  it('when both propose at once later on, the polite end gives way and answers', async () => {
    const { peer, connection } = peerWith({ polite: true })
    await peer.signal({ description: OFFER })
    await peer.signal({ description: ANSWER })
    sent.length = 0
    await connection.negotiate()
    expect(connection.signalingState).toBe('have-local-offer')

    await peer.signal({ description: { type: 'offer', sdp: 'their-second' } })

    expect(connection.remote.at(-1)).toEqual({ type: 'offer', sdp: 'their-second' })
    expect(sent).toEqual([{ description: { type: 'offer', sdp: 'offer-2' } }, { description: { type: 'answer', sdp: 'answer-3' } }])
  })

  it('also gives way to an offer that arrives while its own is still being made', async () => {
    const impolite = peerWith({ polite: false })
    impolite.connection.slow = true
    const making = impolite.connection.negotiate()
    await impolite.peer.signal({ description: OFFER })
    impolite.connection.finish()
    await making
    expect(impolite.connection.remote).toEqual([])
  })

  it('shows everything the other end sends as one stream, anew each time it changes', () => {
    const { connection } = peerWith()
    const [voice, picture] = [track('audio'), track('video')]

    connection.ontrack?.({ track: voice })
    connection.ontrack?.({ track: picture })
    connection.ontrack?.({ track: picture })

    expect(streams.map(stream => stream.getTracks())).toEqual([[voice], [voice, picture], [voice, picture]])
    expect(streams[0]).not.toBe(streams[1])
  })

  it('says when the two ends reach each other and when they stop, and looks for a new path when there is none', () => {
    const { connection } = peerWith()

    connection.become('connecting')
    connection.become('connected')
    connection.become('disconnected')
    connection.become('connected')
    connection.become('failed')

    expect(reached).toEqual(['connected', 'interrupted', 'connected', 'interrupted'])
    expect(connection.restarts).toBe(1)
  })

  it('can be asked to look for a path again', () => {
    const { peer, connection } = peerWith()
    peer.restart()
    expect(connection.restarts).toBe(1)
  })

  it('survives something it cannot take in', async () => {
    const { peer, connection } = peerWith({ polite: true })
    connection.refuseDescriptions = true
    await expect(peer.signal({ description: OFFER })).resolves.toBeUndefined()
    connection.refuseDescriptions = false
    connection.refuseCandidates = true
    await expect(peer.signal({ candidate: CANDIDATE })).resolves.toBeUndefined()
    // And goes on working.
    connection.refuseCandidates = false
    await peer.signal({ description: OFFER })
    expect(sent).toEqual([{ description: { type: 'answer', sdp: 'answer-1' } }])
  })

  it('does nothing more once it is closed', async () => {
    const { peer, connection } = peerWith()
    peer.close()
    peer.close()

    expect(connection.closed).toBe(true)
    expect(connection.onicecandidate).toBeNull()
    await peer.signal({ description: OFFER })
    peer.send(new FakeMediaStream([track('audio')]) as unknown as MediaStream)
    peer.restart()
    expect(connection.remote).toEqual([])
    expect(connection.senders).toEqual([])
    expect(connection.restarts).toBe(0)
    expect(sent).toEqual([])
  })
})
