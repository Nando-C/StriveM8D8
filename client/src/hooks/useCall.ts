import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { callReducer, initialCallState, type CallOutcome } from '@/lib/call/callState'
import { callsSupported, createPeer, type Peer } from '@/lib/call/peer'
import { flashTitle, startRingtone } from '@/lib/call/ringing'
import { onLeaving } from '@/lib/leaving'
import { listen } from '@/lib/listen'
import { ask } from '@/lib/request'
import { socket } from '@/lib/socket'
import type { CallMedia, CallSignal, NamedUser } from '@/types/protocol'

// The user's call: one at a time, for the whole app. What it is doing is `callState`'s
// to say; this hook is what makes it happen — it talks to the server, asks the browser
// for the microphone and camera, and holds the connection to the other browser.

/** How long an answered call may take to find a path between the two devices. */
export const CONNECT_TIMEOUT_MS = 30_000
/** How long the reason a call ended stays on screen by itself. */
export const OUTCOME_SHOWN_MS = 5000
// Things the user has to do something about are left until they close them.
const STAYS: readonly (CallOutcome | null)[] = ['permission', 'no-device', 'unreachable']

// Everything one call holds besides its state. A new object per call: whatever was
// started for a call checks, when it comes back, that the call is still the one.
interface Live {
  callId: string | null
  /** This device's hold on the call: what takes it back after a dropped connection. Never stored, never shown. */
  secret: string | null
  local: MediaStream | null
  peer: Peer | null
  /** Setting the connection up has begun. */
  begun: boolean
  /** The user has pressed accept. */
  answering: boolean
  /** What the other end said before there was a connection to tell it to. */
  waiting: CallSignal[]
  reached: boolean
  connectTimer: ReturnType<typeof setTimeout> | undefined
}

const newLive = (callId: string | null = null): Live => ({
  callId, secret: null, local: null, peer: null, begun: false, answering: false, waiting: [], reached: false, connectTimer: undefined,
})

const stop = (stream: MediaStream | null) => stream?.getTracks().forEach(track => track.stop())

// The microphone, and the camera if asked for. A device with a microphone and no camera
// still makes the call, without picture.
const openMedia = async (video: boolean): Promise<{ stream: MediaStream; video: boolean } | { problem: CallOutcome }> => {
  try {
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: true, video }), video }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') return { problem: 'permission' }
    if (video) {
      const voice = await openMedia(false)
      return 'problem' in voice ? voice : { stream: voice.stream, video: false }
    }
    return { problem: 'no-device' }
  }
}

interface Options {
  /** Connected and logged in. */
  online: boolean
  /** Goes up each time the user is logged in (again). */
  loginCount: number
}

export const useCall = ({ online, loginCount }: Options) => {
  const [state, dispatch] = useReducer(callReducer, initialCallState)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const live = useRef<Live | null>(null)

  /** Lets go of everything the call held: the connection, the camera, the microphone. */
  const release = useCallback(() => {
    const current = live.current
    if (current === null) return
    live.current = null
    clearTimeout(current.connectTimer)
    current.peer?.close()
    stop(current.local)
    setLocalStream(null)
    setRemoteStream(null)
  }, [])

  // Sets up the connection to the other browser, once both sides are in the call.
  const begin = useCallback(async (current: Live, polite: boolean) => {
    const callId = current.callId
    if (callId === null || current.begun) return
    current.begun = true
    const config = await ask('call:config', { callId })
    if (live.current !== current) return
    try {
      current.peer = createPeer({
        polite,
        // (Without an answer the call is still tried: two devices on one network need no server to find each other.)
        iceServers: config.ok ? config.iceServers : [],
        send: signal => void ask('call:signal', { callId, ...signal }),
        onRemoteStream: stream => {
          if (live.current === current) setRemoteStream(stream)
        },
        onConnection: reached => {
          if (live.current !== current) return
          if (reached === 'connected') {
            current.reached = true
            clearTimeout(current.connectTimer)
          }
          dispatch(reached === 'connected' ? { type: 'connected', at: Date.now() } : { type: 'interrupted' })
        },
      })
    } catch {
      void ask('call:end', { callId })
      release()
      dispatch({ type: 'failed', outcome: 'unreachable' })
      return
    }
    if (current.local !== null) current.peer.send(current.local)
    for (const signal of current.waiting.splice(0)) void current.peer.signal(signal)
    current.connectTimer = setTimeout(() => {
      if (live.current !== current || current.reached) return
      void ask('call:end', { callId })
      release()
      dispatch({ type: 'failed', outcome: 'unreachable' })
    }, CONNECT_TIMEOUT_MS)
  }, [release])

  useEffect(() => listen(on => {
    on('call:incoming', call => {
      if (live.current !== null) return
      live.current = newLive(call.callId)
      dispatch({ type: 'incoming', call })
    })
    on('call:accepted', ({ callId }) => {
      const current = live.current
      if (current === null || current.callId !== callId) return
      dispatch({ type: 'accepted', callId })
      void begin(current, false)
    })
    on('call:signal', ({ callId, ...signal }) => {
      const current = live.current
      if (current === null || current.callId !== callId) return
      if (current.peer === null) current.waiting.push(signal)
      else void current.peer.signal(signal)
    })
    on('call:peer', ({ callId, connected }) => dispatch({ type: 'peer', callId, connected }))
    on('call:ended', ({ callId, reason }) => {
      if (live.current?.callId !== callId) return
      release()
      dispatch({ type: 'ended', callId, reason })
    })
  }), [begin, release])

  // Leaving the page hangs up: the other person is not left waiting on a call nobody is in.
  // Said twice: over the socket, which is quickest, and by a beacon — the one thing a
  // browser undertakes to deliver from a page that is going away.
  useEffect(() => onLeaving(() => {
    const current = live.current
    // (Only a call this device is in. One that merely rings here goes on ringing on the user's other devices.)
    if (current === null || current.callId === null || current.secret === null) return
    socket.emit('call:end', { callId: current.callId }, () => {})
    navigator.sendBeacon?.(`${import.meta.env.VITE_BACKEND_URL}/call/leave`, JSON.stringify({ callId: current.callId, secret: current.secret }))
  }), [])
  useEffect(() => release, [release])

  // A call that only rings here is the server's to ring: if the connection goes, it
  // stops — and rings again on logging back in, if it is still being made.
  useEffect(() => {
    const current = live.current
    if (online || current === null || current.answering || current.secret !== null || current.callId === null) return
    release()
    dispatch({ type: 'hungUp' })
  }, [online, release])

  // Logged in again on a new connection: the call is taken back, with this device's secret.
  const lastLogin = useRef(loginCount)
  useEffect(() => {
    if (lastLogin.current === loginCount) return
    lastLogin.current = loginCount
    const current = live.current
    if (current === null || current.callId === null || current.secret === null) return
    void ask('call:rejoin', { callId: current.callId, secret: current.secret }).then(answer => {
      if (live.current !== current) return
      if (!answer.ok) {
        // (Not a server that did not answer: that one may yet.)
        if ('retryable' in answer && answer.retryable === true) return
        release()
        dispatch({ type: 'failed', outcome: 'failed' })
        return
      }
      // Accepted while this device was away: what it was not told then.
      if (answer.state === 'active' && !current.begun && current.callId !== null) {
        dispatch({ type: 'accepted', callId: current.callId })
        void begin(current, false)
      }
      current.peer?.restart()
    })
  }, [loginCount, begin, release])

  // An incoming call makes itself heard, and seen from another tab.
  const ringing = state.phase === 'incoming'
  const caller = state.peer?.username
  useEffect(() => {
    if (!ringing) return
    const silence = startRingtone()
    const restore = flashTitle(`${caller ?? 'Someone'} is calling…`)
    return () => {
      silence()
      restore()
    }
  }, [ringing, caller])

  // Why a call ended is said for a moment, then gets out of the way.
  useEffect(() => {
    if (state.phase !== 'ended' || STAYS.includes(state.outcome)) return
    const timer = setTimeout(() => dispatch({ type: 'dismissed' }), OUTCOME_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [state.phase, state.outcome])

  /** Calls someone. */
  const start = useCallback(async (peer: NamedUser, media: CallMedia, conversationId: string) => {
    if (live.current !== null || !online) return
    const current = newLive()
    live.current = current
    dispatch({ type: 'calling', peer, media, conversationId })

    // The microphone first: nobody is rung by someone who then cannot speak.
    const opened = await openMedia(media === 'video')
    if (live.current !== current) return stop('problem' in opened ? null : opened.stream)
    if ('problem' in opened) {
      release()
      dispatch({ type: 'failed', outcome: opened.problem })
      return
    }
    current.local = opened.stream
    setLocalStream(opened.stream)
    if (media === 'video' && !opened.video) dispatch({ type: 'cameraUnavailable' })

    const answer = await ask('call:invite', { to: peer.userId, media })
    if (!answer.ok) {
      if (live.current !== current) return
      release()
      dispatch({ type: 'failed', outcome: answer.reason ?? 'refused', message: answer.message })
      return
    }
    // Hung up before the server had answered: now it can be told which call.
    if (live.current !== current) return void ask('call:end', { callId: answer.callId })
    current.callId = answer.callId
    current.secret = answer.secret
    dispatch({ type: 'invited', callId: answer.callId })
  }, [online, release])

  /** Accepts the call that is ringing, with or without picture. */
  const accept = useCallback(async (video: boolean) => {
    const current = live.current
    if (current === null || current.callId === null || current.answering || current.secret !== null) return
    const callId = current.callId
    current.answering = true
    dispatch({ type: 'answering', video })

    const opened = await openMedia(video)
    if (live.current !== current) return stop('problem' in opened ? null : opened.stream)
    if ('problem' in opened) {
      void ask('call:decline', { callId })
      release()
      dispatch({ type: 'failed', outcome: opened.problem })
      return
    }
    current.local = opened.stream
    setLocalStream(opened.stream)
    if (video && !opened.video) dispatch({ type: 'cameraUnavailable' })

    const answer = await ask('call:accept', { callId })
    if (live.current !== current) return
    if (!answer.ok) {
      release()
      // Taken on another of the user's devices: it goes on there, and there is nothing to say here.
      dispatch(answer.reason === 'answered-elsewhere' ? { type: 'hungUp' } : { type: 'failed', outcome: 'refused', message: answer.message })
      return
    }
    current.secret = answer.secret
    await begin(current, true)
  }, [begin, release])

  /** Hangs up — which, for a call that is still ringing, cancels or declines it. */
  const hangUp = useCallback(() => {
    const current = live.current
    if (current === null) return
    if (current.callId !== null) void ask('call:end', { callId: current.callId })
    release()
    dispatch({ type: 'hungUp' })
  }, [release])

  const toggleMic = useCallback(() => {
    const local = live.current?.local
    if (local == null) return
    for (const track of local.getAudioTracks()) track.enabled = !track.enabled
    dispatch({ type: 'micToggled' })
  }, [])

  /** Stops or starts sending picture — opening the camera first, in a call that began without one. */
  const toggleCamera = useCallback(async () => {
    const current = live.current
    if (current?.local == null) return
    const tracks = current.local.getVideoTracks()
    if (tracks.length > 0) {
      for (const track of tracks) track.enabled = !track.enabled
      dispatch({ type: 'cameraToggled' })
      return
    }
    try {
      const camera = await navigator.mediaDevices.getUserMedia({ video: true })
      if (live.current !== current || current.local === null) return stop(camera)
      for (const track of camera.getVideoTracks()) current.local.addTrack(track)
      current.peer?.send(current.local)
      // (A new stream, so that the preview sees there is now a picture.)
      setLocalStream(new MediaStream(current.local.getTracks()))
      dispatch({ type: 'cameraToggled' })
    } catch {
      // No camera, or not allowed: the call goes on without picture.
    }
  }, [])

  const setMinimised = useCallback((minimised: boolean) => dispatch({ type: 'minimised', minimised }), [])
  const dismiss = useCallback(() => dispatch({ type: 'dismissed' }), [])

  return {
    state,
    localStream,
    remoteStream,
    /** Whether this browser can make calls at all. */
    supported: callsSupported(),
    start,
    accept,
    hangUp,
    toggleMic,
    toggleCamera,
    setMinimised,
    dismiss,
  }
}

export type Call = ReturnType<typeof useCall>
