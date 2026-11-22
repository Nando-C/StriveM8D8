import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { callReducer, initialCallState, pictureSent, type CallOutcome } from '@/lib/call/callState'
import {
  canShareScreen, chooseDevice, chosenDevices, listDevices, NO_DEVICES, preferring, type ChosenDevices, type DeviceKind, type Devices,
} from '@/lib/call/devices'
import { callsSupported, createPeer, type Peer, type Picture } from '@/lib/call/peer'
import { createQualityMeter, QUALITY_PERIOD_MS } from '@/lib/call/quality'
import { allowSound, flashTitle, startRingtone } from '@/lib/call/ringing'
import { onLeaving } from '@/lib/leaving'
import { listen } from '@/lib/listen'
import { ask } from '@/lib/request'
import { socket } from '@/lib/socket'
import type { CallMedia, CallSignal, IceServer, NamedUser } from '@/types/protocol'

// The user's call: one at a time, for the whole app. What it is doing is `callState`'s
// to say; this hook is what makes it happen — it talks to the server, asks the browser
// for the microphone and camera, and holds the connection to the other browser.

/** How long an answered call may take to find a path between the two devices. */
export const CONNECT_TIMEOUT_MS = 30_000
/** How long the reason a call ended stays on screen by itself. */
export const OUTCOME_SHOWN_MS = 5000
/** How long a call may go on being taken back after the connection returned, when the server does not answer. */
export const REJOIN_FOR_MS = 15_000
/** How long after an unanswered attempt the next is made. */
export const REJOIN_AGAIN_MS = 1000
// Where to look for a path if the server could not be asked for its list: free, and needs no credentials.
const FALLBACK_SERVERS: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }]
// Things the user has to do something about are left until they close them.
const STAYS: readonly (CallOutcome | null)[] = ['permission', 'no-device', 'unreachable']

// Everything one call holds besides its state. A new object per call: whatever was
// started for a call checks, when it comes back, that the call is still the one.
interface Live {
  callId: string | null
  /** This device's hold on the call: what takes it back after a dropped connection. Never stored, never shown. */
  secret: string | null
  local: MediaStream | null
  /** The user's screen, while it is sent in place of the camera. */
  screen: MediaStreamTrack | null
  /** What picture the other end is to be told this one sends. */
  picture: Picture
  peer: Peer | null
  /** Setting the connection up has begun. */
  begun: boolean
  /** The user has pressed accept. */
  answering: boolean
  /** What the other end said before there was a connection to tell it to. */
  waiting: CallSignal[]
  reached: boolean
  connectTimer: ReturnType<typeof setTimeout> | undefined
  rejoinTimer: ReturnType<typeof setTimeout> | undefined
  /** Which attempt to take the call back is the current one: an earlier one's answer is no longer of interest. */
  rejoin: number
  /** Changes to what is sent, one after another: each opens a microphone, a camera or the screen, which takes a while. */
  turn: Promise<unknown>
  /** The named changes asked for and not yet made: asking again meanwhile changes nothing. */
  pending: Set<string>
}

// Makes a change to what a call sends once those asked for before it are done. With a
// `name`, a change of that name already waiting or under way is not asked for twice (a
// button pressed again before it has taken effect).
const inTurn = <T,>(current: Live, name: string | null, change: () => Promise<T>): Promise<T | undefined> => {
  if (name !== null) {
    if (current.pending.has(name)) return Promise.resolve(undefined)
    current.pending.add(name)
  }
  const made = current.turn.then(change).finally(() => {
    if (name !== null) current.pending.delete(name)
  })
  current.turn = made.catch(() => {})
  return made
}

const newLive = (callId: string | null = null): Live => ({
  callId, secret: null, local: null, screen: null, picture: 'none', peer: null, begun: false, answering: false, waiting: [], reached: false, connectTimer: undefined,
  rejoinTimer: undefined, rejoin: 0, turn: Promise.resolve(), pending: new Set(),
})

const stop = (stream: MediaStream | null) => stream?.getTracks().forEach(track => track.stop())

/** Whether a camera looks away from the user. (A browser that does not say is taken to have one that looks at them.) */
const facesAway = (camera: MediaStreamTrack | undefined) => camera?.getSettings?.().facingMode === 'environment'

/** The same tracks in a new stream: whoever shows it sees that it changed. */
const shown = (stream: MediaStream) => new MediaStream(stream.getTracks())

// The microphone, and the camera if asked for — those the user chose last time, if they
// are still there. A device with a microphone and no camera still makes the call,
// without picture.
const openMedia = async (video: boolean): Promise<{ stream: MediaStream; video: boolean } | { problem: CallOutcome }> => {
  try {
    const chosen = chosenDevices()
    const constraints = { audio: preferring(chosen.microphone), video: video && preferring(chosen.camera) }
    return { stream: await navigator.mediaDevices.getUserMedia(constraints), video }
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
  /** This page is somebody: not signed out, nor put aside by another tab. (Merely disconnected, it still is.) */
  signedIn: boolean
}

export const useCall = ({ online, loginCount, signedIn }: Options) => {
  const [state, dispatch] = useReducer(callReducer, initialCallState)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [devices, setDevices] = useState<Devices>(NO_DEVICES)
  const [chosen, setChosen] = useState<ChosenDevices>(chosenDevices)
  const live = useRef<Live | null>(null)

  /** Lets go of everything the call held: the connection, the camera, the microphone. */
  const release = useCallback(() => {
    const current = live.current
    if (current === null) return
    live.current = null
    clearTimeout(current.connectTimer)
    clearTimeout(current.rejoinTimer)
    current.peer?.close()
    stop(current.local)
    if (current.screen !== null) {
      current.screen.onended = null
      current.screen.stop()
    }
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
        // (Without an answer the call is still tried, with the server anyone may use.)
        iceServers: config.ok ? config.iceServers : FALLBACK_SERVERS,
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
        onPicture: picture => {
          if (live.current === current) dispatch({ type: 'peerPicture', picture })
        },
      })
    } catch {
      void ask('call:end', { callId })
      release()
      dispatch({ type: 'failed', outcome: 'unreachable' })
      return
    }
    if (current.local !== null) current.peer.send(current.local)
    current.peer.say(current.picture)
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
      const own = live.current
      if (own !== null) {
        // A call of the user's own that the server has not been asked for yet: someone got
        // in first, and that call would only be refused. It is let go for the one that is real.
        if (own.callId !== null || own.answering) return
        release()
        dispatch({ type: 'hungUp' })
      }
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
    on('call:peer', ({ callId, connected }) => {
      dispatch({ type: 'peer', callId, connected })
      // Back, on a new connection and perhaps a new network: the old path may be gone,
      // and what was said to it while it was away never arrived.
      if (connected && live.current?.callId === callId) live.current.peer?.restart()
    })
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

  // Signed out, or put aside by another tab: the server has ended this device's call, and
  // does not tell a connection that is nobody.
  useEffect(() => {
    if (signedIn || live.current === null) return
    release()
    dispatch({ type: 'hungUp' })
  }, [signedIn, release])

  // Logged in again on a new connection: the call is taken back, with this device's secret.
  const lastLogin = useRef(loginCount)
  useEffect(() => {
    if (lastLogin.current === loginCount) return
    lastLogin.current = loginCount
    const current = live.current
    if (current === null || current.callId === null || current.secret === null) return
    const { callId, secret } = current
    const attempt = (current.rejoin += 1)
    const since = Date.now()
    clearTimeout(current.rejoinTimer)
    const lost = () => {
      release()
      dispatch({ type: 'failed', outcome: 'failed' })
    }
    const rejoin = () => void ask('call:rejoin', { callId, secret }).then(answer => {
      if (live.current !== current || current.rejoin !== attempt) return
      if (!answer.ok) {
        // A server that did not answer may yet — for as long as it would keep the call.
        // After that it has ended it, and told only the other side.
        if (!('retryable' in answer && answer.retryable === true)) return lost()
        if (Date.now() - since >= REJOIN_FOR_MS) return lost()
        current.rejoinTimer = setTimeout(rejoin, REJOIN_AGAIN_MS)
        return
      }
      // Accepted while this device was away: what it was not told then.
      if (answer.state === 'active' && !current.begun) {
        dispatch({ type: 'accepted', callId })
        void begin(current, false)
      }
      current.peer?.restart()
    })
    rejoin()
  }, [loginCount, begin, release])

  // This device joined a network (Wi-Fi came back, or mobile data took over): the path
  // through the old one is gone, and is not waited for.
  useEffect(() => {
    const joined = () => live.current?.peer?.restart()
    window.addEventListener('online', joined)
    return () => window.removeEventListener('online', joined)
  }, [])

  // The other end is told what picture it is being sent: a camera that is off sends
  // black, which only this end knows is not a picture.
  const picture = pictureSent(state)
  useEffect(() => {
    const current = live.current
    if (current === null) return
    current.picture = picture
    current.peer?.say(picture)
  }, [picture])

  // While the call lasts, the path is looked at now and then, to say when it is poor.
  const active = state.phase === 'active'
  useEffect(() => {
    if (!active) return
    const current = live.current
    const isPoor = createQualityMeter()
    const looking = setInterval(() => {
      void current?.peer?.sample().then(sample => {
        if (sample !== null && live.current === current) dispatch({ type: 'quality', poor: isPoor(sample) })
      })
    }, QUALITY_PERIOD_MS)
    return () => clearInterval(looking)
  }, [active])

  // The page may make sound once the user has touched it.
  useEffect(() => allowSound(), [])

  // A call makes itself heard at both ends while it rings, and an incoming one is seen from another tab.
  // (At the caller's end only once the server has said that it rings.)
  const ringing = state.phase === 'incoming' || (state.phase === 'outgoing' && state.callId !== null) ? state.phase : null
  const caller = state.peer?.username
  useEffect(() => {
    if (ringing === null) return
    const silence = startRingtone(ringing)
    const restore = ringing === 'incoming' ? flashTitle(`${caller ?? 'Someone'} is calling…`) : () => {}
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
    dispatch({ type: 'facing', away: facesAway(opened.stream.getVideoTracks()[0]) })

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
      // Not declined: it may be answered on another of the user's devices, where there is
      // a microphone. If there is none, the caller is told nobody answered — which is so.
      release()
      dispatch({ type: 'failed', outcome: opened.problem })
      return
    }
    current.local = opened.stream
    setLocalStream(opened.stream)
    if (video && !opened.video) dispatch({ type: 'cameraUnavailable' })
    dispatch({ type: 'facing', away: facesAway(opened.stream.getVideoTracks()[0]) })

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
  const toggleCameraNow = useCallback(async () => {
    const current = live.current
    if (current?.local == null) return
    const tracks = current.local.getVideoTracks()
    if (tracks.length > 0) {
      for (const track of tracks) track.enabled = !track.enabled
      dispatch({ type: 'cameraToggled' })
      return
    }
    try {
      const camera = await navigator.mediaDevices.getUserMedia({ video: preferring(chosenDevices().camera) })
      const [track] = camera.getVideoTracks()
      if (live.current !== current || current.local === null || track === undefined) return stop(camera)
      current.local.addTrack(track)
      // (Not in place of the screen, if that is what is being sent: the camera waits its turn.)
      if (current.screen === null) await current.peer?.put('video', track).catch(() => {})
      setLocalStream(shown(current.local))
      dispatch({ type: 'cameraToggled' })
      dispatch({ type: 'facing', away: facesAway(track) })
    } catch {
      // No camera, or not allowed: the call goes on without picture.
    }
  }, [])

  // One change to what is sent at a time, and no change asked for twice while it is being
  // made: opening a camera takes a moment, and a second press in that moment would open a second.
  const queued = useCallback(<T,>(name: string | null, change: () => Promise<T>) => {
    const current = live.current
    return current === null ? Promise.resolve(undefined) : inTurn(current, name, change)
  }, [])
  const toggleCamera = useCallback(() => queued('camera', toggleCameraNow), [queued, toggleCameraNow])

  // Speaks through another microphone from now on (`undefined`: whichever the browser picks).
  const swapMicrophone = useCallback(async (id: string | undefined) => {
    const current = live.current
    if (current?.local == null) return
    let opened: MediaStream
    try {
      opened = await navigator.mediaDevices.getUserMedia({ audio: id === undefined ? true : { deviceId: { exact: id } } })
    } catch {
      // It cannot be used after all: the call keeps the one it has.
      return
    }
    const [track] = opened.getAudioTracks()
    if (live.current !== current || current.local === null || track === undefined) return stop(opened)
    const [old] = current.local.getAudioTracks()
    if (old !== undefined) {
      // (Muted stays muted.)
      track.enabled = old.enabled
      current.local.removeTrack(old)
      old.stop()
    }
    current.local.addTrack(track)
    await current.peer?.put('audio', track).catch(() => {})
  }, [])

  // Shows through another camera from now on. Returns the camera now in use, if there is one.
  const swapCamera = useCallback(async (wanted: MediaTrackConstraints | true) => {
    const current = live.current
    const old = current?.local?.getVideoTracks()[0]
    // (A camera that was never opened: what was chosen is used when it is.)
    if (current?.local == null || old === undefined) return
    // The one in use is let go first: a phone does not open a second camera beside it.
    old.stop()
    const open = (video: MediaTrackConstraints | true) => navigator.mediaDevices.getUserMedia({ video })
    // (If the one asked for cannot be had, whichever can.)
    const opened = await open(wanted).catch(() => open(true)).catch(() => null)
    if (live.current !== current || current.local === null) return void stop(opened)
    current.local.removeTrack(old)
    const track = opened?.getVideoTracks()[0]
    if (track === undefined) {
      if (current.screen === null) await current.peer?.put('video', null).catch(() => {})
      setLocalStream(shown(current.local))
      dispatch({ type: 'cameraUnavailable' })
      return
    }
    track.enabled = old.enabled
    current.local.addTrack(track)
    if (current.screen === null) await current.peer?.put('video', track).catch(() => {})
    setLocalStream(shown(current.local))
    dispatch({ type: 'facing', away: facesAway(track) })
    return track
  }, [])

  /** Uses this microphone, camera or speaker — now, if a call is under way, and from now on. */
  const choose = useCallback((kind: DeviceKind, id: string | undefined) => {
    setChosen(chooseDevice(kind, id))
    if (kind === 'microphone') void queued(null, () => swapMicrophone(id))
    else if (kind === 'camera') void queued(null, () => swapCamera(id === undefined ? true : { deviceId: { exact: id } }))
    // (The speaker is whoever plays the sound's to use: the call view.)
  }, [queued, swapMicrophone, swapCamera])

  /** On a phone: the camera on the other side of it. */
  const flipCamera = useCallback(() => queued('flip', async () => {
    const away = facesAway(live.current?.local?.getVideoTracks()[0])
    const camera = await swapCamera({ facingMode: { exact: away ? 'user' : 'environment' } })
    const id = camera?.getSettings?.().deviceId
    if (typeof id === 'string' && id !== '') setChosen(chooseDevice('camera', id))
  }), [queued, swapCamera])

  // Goes back from the screen to the camera (or to no picture, without one).
  const stopSharing = useCallback(async (current: Live) => {
    const screen = current.screen
    if (screen === null) return
    current.screen = null
    screen.onended = null
    screen.stop()
    if (live.current !== current) return
    dispatch({ type: 'sharing', sharing: false })
    await current.peer?.put('video', current.local?.getVideoTracks()[0] ?? null).catch(() => {})
  }, [])

  /** Sends the screen (a window, a tab: the browser asks which) in place of the camera — or stops doing so. */
  const toggleSharing = useCallback(() => queued('sharing', async () => {
    const current = live.current
    if (current === null || current.peer === null) return
    if (current.screen !== null) return stopSharing(current)
    let display: MediaStream
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true })
    } catch {
      // The user closed the browser's question, or the browser will not: nothing changes.
      return
    }
    const [track] = display.getVideoTracks()
    if (live.current !== current || current.peer === null || current.screen !== null || track === undefined) return stop(display)
    current.screen = track
    // The browser has a "stop sharing" of its own, outside the page.
    track.onended = () => void stopSharing(current)
    dispatch({ type: 'sharing', sharing: true })
    try {
      await current.peer.put('video', track)
    } catch {
      void stopSharing(current)
    }
  }), [queued, stopSharing])

  // What there is to choose between, while a call has the microphone: the browser names
  // its devices only then. Kept up to date as things are plugged in and pulled out.
  const listening = localStream !== null
  useEffect(() => {
    if (!listening) return
    let stale = false
    const refresh = () => {
      void listDevices().then(found => {
        if (!stale) setDevices(found)
      })
      // The microphone in use was pulled out: whichever the browser picks next.
      if (live.current?.local?.getAudioTracks()[0]?.readyState === 'ended') void queued('unplugged', () => swapMicrophone(undefined))
    }
    refresh()
    const media = navigator.mediaDevices
    media?.addEventListener?.('devicechange', refresh)
    return () => {
      stale = true
      media?.removeEventListener?.('devicechange', refresh)
    }
  }, [listening, queued, swapMicrophone])

  const setMinimised = useCallback((minimised: boolean) => dispatch({ type: 'minimised', minimised }), [])
  const dismiss = useCallback(() => dispatch({ type: 'dismissed' }), [])

  return {
    state,
    localStream,
    remoteStream,
    /** Whether this browser can make calls at all. */
    supported: callsSupported(),
    /** Whether this browser can send the screen. */
    canShare: canShareScreen(),
    /** The microphones, cameras and speakers there are (known during a call), and the user's choice of each. */
    devices,
    chosen,
    choose,
    flipCamera,
    toggleSharing,
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
