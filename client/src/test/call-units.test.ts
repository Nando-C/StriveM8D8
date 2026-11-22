import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callClock, callOutcomeLine, callReducer, callStatusLine, initialCallState, isEngaged, pictureSent,
  type CallAction, type CallOutcome, type CallPhase, type CallState,
} from '@/lib/call/callState'
import { chooseDevice, chosenDevices, listDevices, preferring } from '@/lib/call/devices'
import { createPeer, LOST_PATIENCE_MS, POLITE_HEAD_START_MS, type PathSample, type PeerOptions } from '@/lib/call/peer'
import { createQualityMeter, isPoorBetween } from '@/lib/call/quality'
import { flashTitle } from '@/lib/call/ringing'
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

  it('keeps track of the screen being sent, which way the camera looks, what the other side sends and how the path is', () => {
    const sharing = callReducer(IN.active, { type: 'sharing', sharing: true })
    expect(sharing.sharing).toBe(true)
    expect(callReducer(sharing, { type: 'sharing', sharing: true })).toBe(sharing)
    // The screen goes in place of the camera, which stays as it was for afterwards.
    expect(pictureSent(sharing)).toBe('screen')
    expect(pictureSent(IN.active)).toBe('camera')
    expect(pictureSent(callReducer(IN.active, { type: 'cameraToggled' }))).toBe('none')

    expect(callReducer(IN.active, { type: 'facing', away: true }).facingAway).toBe(true)
    expect(callReducer(IN.active, { type: 'facing', away: false })).toBe(IN.active)

    expect(IN.active.peerPicture).toBeNull()
    expect(callReducer(IN.connecting, { type: 'peerPicture', picture: 'none' }).peerPicture).toBe('none')

    const poor = callReducer(IN.active, { type: 'quality', poor: true })
    expect(poor.poor).toBe(true)
    expect(callReducer(poor, { type: 'quality', poor: true })).toBe(poor)
    // (Nothing is said of a path that is not there yet, or of no call at all.)
    expect(callReducer(IN.connecting, { type: 'quality', poor: true })).toBe(IN.connecting)
    for (const action of [{ type: 'sharing', sharing: true }, { type: 'facing', away: true }, { type: 'peerPicture', picture: 'screen' }] as CallAction[]) {
      expect(callReducer(IN.idle, action)).toBe(IN.idle)
      expect(callReducer(IN.ended, action)).toBe(IN.ended)
    }
    // And none of it outlives the call.
    expect(callReducer(callReducer(sharing, { type: 'hungUp' }), calling)).toMatchObject({ sharing: false, peerPicture: null, poor: false, facingAway: false })
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
  let pictures: string[]
  const peerWith = (options: Partial<PeerOptions> = {}) => {
    const peer = createPeer({
      polite: false, iceServers: [{ urls: ['stun:stun.test:3478'] }],
      send: signal => sent.push(signal),
      onRemoteStream: stream => streams.push(stream as unknown as FakeMediaStream),
      onConnection: state => reached.push(state),
      onPicture: picture => pictures.push(picture),
      ...options,
    })
    return { peer, connection: FakePeerConnection.last() }
  }

  beforeEach(() => {
    sent = []
    streams = []
    reached = []
    pictures = []
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

  it('swaps what it sends of a kind without proposing anything, and can send nothing', async () => {
    const { peer, connection } = peerWith()
    const [voice, camera, screen] = [track('audio'), track('video'), track('video')]
    peer.send(new FakeMediaStream([voice, camera]) as unknown as MediaStream)

    await peer.put('video', screen as unknown as MediaStreamTrack)
    expect(connection.senders.map(sender => sender.track)).toEqual([voice, screen])
    await peer.put('video', null)
    expect(connection.senders.map(sender => sender.track)).toEqual([voice, null])
    // The same sender takes the camera back — also when handed a whole stream.
    peer.send(new FakeMediaStream([voice, camera]) as unknown as MediaStream)
    await Promise.resolve()
    expect(connection.senders.map(sender => sender.track)).toEqual([voice, camera])
  })

  it('starts sending a kind it was not sending, and has nothing to take away where nothing was sent', async () => {
    const { peer, connection } = peerWith()
    await peer.put('video', null)
    expect(connection.senders).toEqual([])
    const screen = track('video')
    await peer.put('video', screen as unknown as MediaStreamTrack)
    expect(connection.senders.map(sender => sender.track)).toEqual([screen])
  })

  it('tells the other end what picture it sends, as soon as there is a line to say it on, and each time it changes', () => {
    const { peer, connection } = peerWith()
    const [channel] = connection.channels
    // The same line on both ends, agreed in advance.
    expect(channel.options).toEqual({ negotiated: true, id: 0 })

    peer.say('camera')
    expect(channel.sent).toEqual([])
    channel.open()
    peer.say('screen')
    peer.say('none')

    expect(channel.sent.map(said => JSON.parse(said))).toEqual([{ picture: 'camera' }, { picture: 'screen' }, { picture: 'none' }])
  })

  it('hears what picture the other end sends — and nothing else it might say', () => {
    const { connection } = peerWith()
    const [channel] = connection.channels
    channel.open()

    channel.receive(JSON.stringify({ picture: 'none' }))
    channel.receive(JSON.stringify({ picture: 'screen', somethingElse: true }))
    for (const junk of ['', 'not json', 'null', '[]', '{"picture":"hologram"}', '{"picture":5}', new ArrayBuffer(4), `{"picture":"none","padding":"${'x'.repeat(300)}"}`]) {
      channel.receive(junk)
    }

    expect(pictures).toEqual(['none', 'screen'])
  })

  it('works in a browser that cannot open such a line', async () => {
    class Without extends FakePeerConnection {
      createDataChannel = () => {
        throw new Error('not supported')
      }
    }
    vi.stubGlobal('RTCPeerConnection', Without)
    const { peer } = peerWith({ polite: true })
    peer.say('camera')
    await peer.signal({ description: OFFER })
    expect(sent).toEqual([{ description: { type: 'answer', sdp: 'answer-1' } }])
  })

  it('reads how the path is doing from what the browser counts', async () => {
    const { peer, connection } = peerWith()
    connection.stats = [
      { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.12 },
      { type: 'candidate-pair', state: 'failed', nominated: false, currentRoundTripTime: 9 },
      { type: 'inbound-rtp', kind: 'audio', packetsReceived: 900, packetsLost: 10 },
      { type: 'inbound-rtp', kind: 'video', packetsReceived: 2100, packetsLost: -3 },
      { type: 'outbound-rtp', packetsSent: 5000 },
    ]
    expect(await peer.sample()).toEqual({ roundTripMs: 120, received: 3000, lost: 10 })

    connection.stats = []
    expect(await peer.sample()).toEqual({ roundTripMs: null, received: 0, lost: 0 })
    connection.getStats = async () => {
      throw new Error('closed')
    }
    expect(await peer.sample()).toBeNull()
  })

  describe('looking for a new path', () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it('is not done by both ends at once: the polite one gives the other a head start', () => {
      const { peer, connection } = peerWith({ polite: true })

      peer.restart()
      expect(connection.restarts).toBe(0)
      vi.advanceTimersByTime(POLITE_HEAD_START_MS)

      expect(connection.restarts).toBe(1)
    })

    it('is left to the other end if that one proposed meanwhile', async () => {
      const { peer, connection } = peerWith({ polite: true })

      peer.restart()
      await peer.signal({ description: OFFER })
      vi.advanceTimersByTime(POLITE_HEAD_START_MS)

      expect(connection.restarts).toBe(0)
    })

    it('says an unanswered offer again: the other end may have been away when it was sent', async () => {
      const { peer, connection } = peerWith()
      await connection.negotiate()
      expect(sent).toHaveLength(1)

      peer.restart()

      expect(sent).toEqual([{ description: { type: 'offer', sdp: 'offer-1' } }, { description: { type: 'offer', sdp: 'offer-1' } }])
      // (Nothing to say again once it was answered.)
      await peer.signal({ description: ANSWER })
      peer.restart()
      expect(sent).toHaveLength(2)
      expect(connection.restarts).toBe(2)
    })

    it('begins shortly after the two ends lose each other, if they have not found each other again', () => {
      const { connection } = peerWith()
      connection.become('connected')

      // A moment without signal passes by itself.
      connection.become('disconnected')
      vi.advanceTimersByTime(LOST_PATIENCE_MS - 1)
      connection.become('connected')
      vi.advanceTimersByTime(LOST_PATIENCE_MS)
      expect(connection.restarts).toBe(0)

      connection.become('disconnected')
      vi.advanceTimersByTime(LOST_PATIENCE_MS)
      expect(connection.restarts).toBe(1)
    })

    it('is not begun for a connection that was closed meanwhile', () => {
      const { peer, connection } = peerWith({ polite: true })
      connection.become('disconnected')
      peer.restart()
      peer.close()
      vi.advanceTimersByTime(POLITE_HEAD_START_MS + LOST_PATIENCE_MS)
      expect(connection.restarts).toBe(0)
    })
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

describe('how good the connection is', () => {
  const reading = (received: number, lost: number, roundTripMs: number | null = 40): PathSample => ({ roundTripMs, received, lost })

  it.each<[string, PathSample | null, PathSample, boolean]>([
    ['nothing lost', reading(1000, 0), reading(2000, 0), false],
    ['a little lost', reading(1000, 0), reading(2000, 20), false],
    ['a lot lost', reading(1000, 0), reading(2000, 100), true],
    ['a lot lost long ago', reading(1000, 100), reading(2000, 100), false],
    ['slow', reading(1000, 0), reading(2000, 0, 650), true],
    ['of unknown speed', reading(1000, 0), reading(2000, 0, null), false],
    ['a first reading', null, reading(50, 1), false],
    ['a first reading of heavy loss', null, reading(50, 10), true],
    ['nothing arriving at all', reading(1000, 0), reading(1000, 0), false],
    ['counted anew on a new path', reading(5000, 300), reading(200, 2), false],
  ])('%s', (_, before, now, poor) => {
    expect(isPoorBetween(before, now)).toBe(poor)
  })

  it('is called poor only when it stays so, and good again as soon as it is', () => {
    const isPoor = createQualityMeter()
    expect(isPoor(reading(1000, 0))).toBe(false)
    expect(isPoor(reading(2000, 200))).toBe(false)
    expect(isPoor(reading(3000, 200))).toBe(false)
    expect(isPoor(reading(4000, 400))).toBe(false)
    expect(isPoor(reading(5000, 600))).toBe(true)
    expect(isPoor(reading(6000, 600))).toBe(false)
  })
})

describe('the devices a call uses', () => {
  afterEach(() => {
    window.localStorage.clear()
    Reflect.deleteProperty(navigator, 'mediaDevices')
  })

  it('remembers the choice of each kind, and forgets it when it is left to the browser again', () => {
    expect(chosenDevices()).toEqual({})
    chooseDevice('microphone', 'mic-2')
    expect(chooseDevice('speaker', 'out-1')).toEqual({ microphone: 'mic-2', speaker: 'out-1' })
    expect(chosenDevices()).toEqual({ microphone: 'mic-2', speaker: 'out-1' })
    expect(chooseDevice('microphone', undefined)).toEqual({ speaker: 'out-1' })
    expect(chosenDevices()).toEqual({ speaker: 'out-1' })
  })

  it.each(['not json', '"mic-2"', '[]', '{"microphone":5,"camera":"","speaker":null,"hologram":"x"}', `{"camera":"${'x'.repeat(600)}"}`])(
    'makes nothing of what it cannot read: %s', stored => {
      window.localStorage.setItem('strive-chat.call-devices', stored)
      expect(chosenDevices()).toEqual({})
    })

  it('asks for the chosen device if it is there, and for any otherwise', () => {
    expect(preferring(undefined)).toBe(true)
    expect(preferring('cam-1')).toEqual({ deviceId: { ideal: 'cam-1' } })
  })

  it('lists what the browser has by kind, each once, with a name even where the browser gives none', async () => {
    const enumerateDevices = async () => [
      { kind: 'audioinput', deviceId: 'default', label: 'Default - Built-in' },
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in' },
      { kind: 'audioinput', deviceId: 'mic-2', label: '' },
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in' },
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Front' },
      { kind: 'videoinput', deviceId: '', label: '' },
      { kind: 'audiooutput', deviceId: 'out-1', label: 'Headphones' },
      { kind: 'hologram', deviceId: 'h-1', label: 'Projector' },
    ]
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices } })

    expect(await listDevices()).toEqual({
      microphone: [{ id: 'mic-1', label: 'Built-in' }, { id: 'mic-2', label: 'Microphone 2' }],
      camera: [{ id: 'cam-1', label: 'Front' }],
      speaker: [{ id: 'out-1', label: 'Headphones' }],
    })
  })

  it('has nothing to choose between in a browser that will not say', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} })
    expect(await listDevices()).toEqual({ microphone: [], camera: [], speaker: [] })
  })
})

describe('the tab’s title while a call rings', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('alternates with what was there, and leaves it as it was', () => {
    document.title = 'Chat'
    const restore = flashTitle('bob is calling…')
    expect(document.title).toBe('bob is calling…')
    vi.advanceTimersByTime(1000)
    expect(document.title).toBe('Chat')
    vi.advanceTimersByTime(1000)
    restore()
    expect(document.title).toBe('Chat')
  })

  it('keeps what someone else writes there meanwhile: a message that arrives is still counted when the ringing stops', () => {
    document.title = 'Chat'
    const restore = flashTitle('bob is calling…')

    // Written over the notice: it is what the notice alternates with from then on.
    document.title = '(1) Chat'
    vi.advanceTimersByTime(1000)
    expect(document.title).toBe('(1) Chat')
    vi.advanceTimersByTime(1000)
    expect(document.title).toBe('bob is calling…')
    vi.advanceTimersByTime(1000)
    expect(document.title).toBe('(1) Chat')
    // Written while the notice is not up, likewise.
    document.title = '(2) Chat'
    vi.advanceTimersByTime(1000)
    expect(document.title).toBe('bob is calling…')
    restore()
    expect(document.title).toBe('(2) Chat')

    // Written the very moment it stops: that stays.
    const again = flashTitle('bob is calling…')
    document.title = '(3) Chat'
    again()
    expect(document.title).toBe('(3) Chat')
    vi.advanceTimersByTime(5000)
    expect(document.title).toBe('(3) Chat')
  })
})
