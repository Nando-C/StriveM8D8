import type { CallSignal, IceServer } from '@/types/protocol'

// The connection between the two browsers of a call: a thin layer over
// `RTCPeerConnection` that does one thing — keeps the two ends agreed on what is being
// sent, whoever changes it and whenever, by the "perfect negotiation" pattern
// (developer.mozilla.org/docs/Web/API/WebRTC_API/Perfect_negotiation). Both ends run the
// same code; if both propose a change at the same moment the *polite* one gives way.
// Here the person called is polite.
//
// One thing is added to the pattern. When a call begins both ends have something to
// send at the same instant, so both would propose at once, every time — and giving way
// means taking an offer back, after which Chromium was seen (one call in six, in this
// project's browser tests) never to gather the candidates for its answer: the call
// stayed "connecting" for good. So the polite end does not propose until it has
// answered the other's first offer. That first answer carries what it sends; from then
// on either end may propose, and collisions — now rare — are settled as the pattern says.
//
// For the same reason the two ends do not look for a new path at the same moment: the
// impolite one does so at once, the polite one a few seconds later and only if the other
// has proposed nothing meanwhile.

export type PeerConnectionState = 'connected' | 'interrupted'

/** What picture an end is sending: its camera, its screen, or none. */
export type Picture = 'camera' | 'screen' | 'none'

/** How the path between the two ends is doing, as counted so far. */
export interface PathSample {
  /** How long a packet takes there and back; `null` if not known. */
  roundTripMs: number | null
  /** Packets of the other end's that arrived, and that did not, since the call began. */
  received: number
  lost: number
}

/** How long the polite end leaves the other to look for a new path before doing so itself. */
export const POLITE_HEAD_START_MS = 4000
/** How long the two ends may have lost each other before a new path is looked for. */
export const LOST_PATIENCE_MS = 2000
// (Nothing the other end says of itself is anywhere near as long.)
const MAX_NOTE_LENGTH = 200
const PICTURES: readonly unknown[] = ['camera', 'screen', 'none']

export interface PeerOptions {
  /** Gives way when both ends make an offer at once. */
  polite: boolean
  iceServers: IceServer[]
  /** Passes something to the other end (through the server). */
  send: (signal: CallSignal) => void
  /** What the other end sends, each time it changes: one stream of everything. */
  onRemoteStream: (stream: MediaStream) => void
  /** The two ends reach each other, or have stopped doing so (and a new path is being looked for). */
  onConnection: (state: PeerConnectionState) => void
  /** The other end says what picture it is sending. */
  onPicture: (picture: Picture) => void
}

export interface Peer {
  /** Sends this stream's tracks: each in place of what was being sent of its kind, if anything was. */
  send: (stream: MediaStream) => void
  /** Sends this track in place of what was being sent of its kind — or, with `null`, nothing. */
  put: (kind: 'audio' | 'video', track: MediaStreamTrack | null) => Promise<void>
  /** Tells the other end what picture this one is sending (now, or as soon as it can be told). */
  say: (picture: Picture) => void
  /** How the path is doing; `null` if the browser does not say. */
  sample: () => Promise<PathSample | null>
  /** Takes in what the other end said. */
  signal: (signal: CallSignal) => Promise<void>
  /** Looks for a path again: the network changed, or the other end was away. */
  restart: () => void
  close: () => void
}

export const createPeer = ({ polite, iceServers, send, onRemoteStream, onConnection, onPicture }: PeerOptions): Peer => {
  const connection = new RTCPeerConnection({ iceServers })
  let makingOffer = false
  let ignoreOffer = false
  let settingRemoteAnswer = false
  let closed = false
  // (The impolite end opens; the polite one has "been offered" once it has taken an offer in.)
  let offered = !polite
  /** How many of the other end's offers were taken in. */
  let offersTaken = 0
  const remoteTracks: MediaStreamTrack[] = []
  const senders: { audio?: RTCRtpSender; video?: RTCRtpSender } = {}
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let lostTimer: ReturnType<typeof setTimeout> | undefined

  const later = (ms: number, what: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!closed) what()
    }, ms)
    timers.add(timer)
    return timer
  }

  // A line of its own between the two browsers, for the little each says of itself. Both
  // ends open it under the same number, so it takes no agreeing beyond the first offer.
  // A browser that cannot have one simply never says, and is never told.
  let picture: Picture | null = null
  let channel: RTCDataChannel | null = null
  const sayPicture = () => {
    if (channel?.readyState !== 'open' || picture === null) return
    try {
      channel.send(JSON.stringify({ picture }))
    } catch {
      // The line went just now: it is said again when there is one.
    }
  }
  try {
    channel = connection.createDataChannel('state', { negotiated: true, id: 0 })
    channel.onopen = sayPicture
    channel.onmessage = ({ data }) => {
      // (From the other person's browser: nothing in it is taken on trust.)
      if (closed || typeof data !== 'string' || data.length > MAX_NOTE_LENGTH) return
      try {
        const said: unknown = JSON.parse(data)
        const theirs = typeof said === 'object' && said !== null ? (said as { picture?: unknown }).picture : undefined
        if (PICTURES.includes(theirs)) onPicture(theirs as Picture)
      } catch {
        // Not something this version understands.
      }
    }
  } catch {
    channel = null
  }

  const sendDescription = () => {
    const description = connection.localDescription
    if (description !== null && !closed) send({ description: { type: description.type, sdp: description.sdp } })
  }

  // Something about what this end sends changed (tracks were added, a restart was asked
  // for): propose it. (Fired only while nothing else is being negotiated.)
  connection.onnegotiationneeded = async () => {
    // Not yet: the other end proposes first. (If something is still to be agreed once
    // its offer is answered, the browser says so again.)
    if (!offered) return
    try {
      makingOffer = true
      await connection.setLocalDescription()
      sendDescription()
    } catch {
      // The connection was closed meanwhile, or the other end's offer got in first: either way the next round settles it.
    } finally {
      makingOffer = false
    }
  }

  connection.onicecandidate = ({ candidate }) => {
    // (The end of the candidates is not news the other end needs.)
    if (candidate === null || closed) return
    const { candidate: line, sdpMid, sdpMLineIndex, usernameFragment } = candidate
    send({ candidate: { candidate: line, sdpMid, sdpMLineIndex, usernameFragment } })
  }

  connection.ontrack = ({ track }) => {
    if (!remoteTracks.includes(track)) remoteTracks.push(track)
    // A new stream each time: whoever shows it sees that it changed.
    onRemoteStream(new MediaStream(remoteTracks))
  }

  // Looks for a path again, now. An offer of this end's that is still unanswered may
  // never have arrived (the other end was away from the server): it is said again.
  const again = () => {
    connection.restartIce()
    if (connection.signalingState === 'have-local-offer' && !makingOffer) sendDescription()
  }

  const restart = () => {
    if (closed) return
    if (!polite) return again()
    const taken = offersTaken
    later(POLITE_HEAD_START_MS, () => {
      if (offersTaken === taken) again()
    })
  }

  connection.onconnectionstatechange = () => {
    if (closed) return
    const state = connection.connectionState
    clearTimeout(lostTimer)
    if (state === 'connected') onConnection('connected')
    else if (state === 'disconnected') {
      onConnection('interrupted')
      // It may come back by itself (a moment without signal); if it has not shortly, a
      // network was probably left or joined, and waiting for the browser to give up takes long.
      lostTimer = later(LOST_PATIENCE_MS, () => {
        if (connection.connectionState === 'disconnected') restart()
      })
    } else if (state === 'failed') {
      // No path any more: look for one again.
      onConnection('interrupted')
      restart()
    }
  }

  const signal = async (incoming: CallSignal) => {
    if (closed) return
    try {
      if ('description' in incoming) {
        const { description } = incoming
        const readyForOffer = !makingOffer && (connection.signalingState === 'stable' || settingRemoteAnswer)
        const collision = description.type === 'offer' && !readyForOffer
        // Both proposed at once: the impolite end keeps its own offer and lets this one go.
        ignoreOffer = !polite && collision
        if (ignoreOffer) return
        settingRemoteAnswer = description.type === 'answer'
        // (For the polite end this also takes back its own offer, if it had made one.)
        await connection.setRemoteDescription(description)
        settingRemoteAnswer = false
        if (description.type === 'offer') {
          offered = true
          offersTaken += 1
          await connection.setLocalDescription()
          sendDescription()
        }
      } else {
        try {
          await connection.addIceCandidate(incoming.candidate)
        } catch (error) {
          // A candidate for the offer that was let go belongs to nothing.
          if (!ignoreOffer) throw error
        }
      }
    } catch {
      settingRemoteAnswer = false
      // Something this browser could not take in. If it mattered, the connection does
      // not come about, and that is what the user is told.
    }
  }

  // One sender for sound and one for picture, each kept for the whole call: what it
  // sends can be swapped (another microphone, the screen for the camera) without the two
  // ends having to agree on anything again.
  const put = async (kind: 'audio' | 'video', track: MediaStreamTrack | null) => {
    if (closed) return
    const sender = senders[kind]
    if (sender === undefined) {
      if (track !== null) senders[kind] = connection.addTrack(track)
    } else if (sender.track !== track) {
      await sender.replaceTrack(track)
    }
  }

  const sample = async (): Promise<PathSample | null> => {
    if (closed || typeof connection.getStats !== 'function') return null
    try {
      const found: PathSample = { roundTripMs: null, received: 0, lost: 0 }
      const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
      for (const report of (await connection.getStats()).values() as Iterable<Record<string, unknown>>) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated === true) {
          if (typeof report.currentRoundTripTime === 'number') found.roundTripMs = report.currentRoundTripTime * 1000
        } else if (report.type === 'inbound-rtp') {
          found.received += count(report.packetsReceived)
          found.lost += count(report.packetsLost)
        }
      }
      return found
    } catch {
      return null
    }
  }

  return {
    send: stream => {
      for (const track of stream.getTracks()) {
        // (A swap the browser will not make leaves what was being sent.)
        if (track.kind === 'audio' || track.kind === 'video') void put(track.kind, track).catch(() => {})
      }
    },
    put,
    say: said => {
      picture = said
      sayPicture()
    },
    sample,
    signal,
    restart,
    close: () => {
      if (closed) return
      closed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      if (channel !== null) channel.onopen = channel.onmessage = null
      connection.onnegotiationneeded = null
      connection.onicecandidate = null
      connection.ontrack = null
      connection.onconnectionstatechange = null
      connection.close()
    },
  }
}

/** Whether this browser can make calls at all (it cannot on a page not served securely). */
export const callsSupported = () =>
  typeof RTCPeerConnection !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
