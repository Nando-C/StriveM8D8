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

export type PeerConnectionState = 'connected' | 'interrupted'

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
}

export interface Peer {
  /** Starts sending this stream's tracks — those of them not being sent already. */
  send: (stream: MediaStream) => void
  /** Takes in what the other end said. */
  signal: (signal: CallSignal) => Promise<void>
  /** Looks for a path again: the network changed, or the other end was away. */
  restart: () => void
  close: () => void
}

export const createPeer = ({ polite, iceServers, send, onRemoteStream, onConnection }: PeerOptions): Peer => {
  const connection = new RTCPeerConnection({ iceServers })
  let makingOffer = false
  let ignoreOffer = false
  let settingRemoteAnswer = false
  let closed = false
  // (The impolite end opens; the polite one has "been offered" once it has taken an offer in.)
  let offered = !polite
  const remoteTracks: MediaStreamTrack[] = []

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

  connection.onconnectionstatechange = () => {
    if (closed) return
    const state = connection.connectionState
    if (state === 'connected') onConnection('connected')
    else if (state === 'disconnected') onConnection('interrupted')
    else if (state === 'failed') {
      // No path any more (a network was left, or joined): look for one again.
      onConnection('interrupted')
      connection.restartIce()
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

  return {
    send: stream => {
      if (closed) return
      const sent = new Set(connection.getSenders().map(sender => sender.track))
      for (const track of stream.getTracks()) if (!sent.has(track)) connection.addTrack(track, stream)
    },
    signal,
    restart: () => {
      if (!closed) connection.restartIce()
    },
    close: () => {
      if (closed) return
      closed = true
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
