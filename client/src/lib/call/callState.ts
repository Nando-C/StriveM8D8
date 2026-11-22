import type { Picture } from '@/lib/call/peer'
import type { CallEndReason, CallIncomingPayload, CallMedia, NamedUser } from '@/types/protocol'

// What the user's call is doing, as a pure state machine: nothing here touches a socket,
// a camera or a connection. `useCall` feeds it what happens and acts on what it says.
//
//   idle ─ calling ─▶ outgoing ─ accepted ─▶ connecting ─ connected ─▶ active
//   idle ─ incoming ▶ incoming ─ answering ▶ connecting
//   any of those ─ ended / failed ─▶ ended (something to tell the user) or idle (nothing to)
//   ended ─ dismissed ─▶ idle

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended'

/**
 * Why a call is over, as far as the user is told: what the server said (a reason of
 * `call:ended`, or of a refused invitation) or what went wrong on this device.
 */
export type CallOutcome =
  | CallEndReason
  | 'unavailable' | 'busy' | 'dnd' | 'in-call'
  /** The browser was not allowed to use the microphone or camera. */
  | 'permission'
  /** There is no microphone (or nothing at all) to use. */
  | 'no-device'
  /** It was answered, but no path between the two devices was found. */
  | 'unreachable'
  /** The server said no, in words of its own (`message`). */
  | 'refused'

export interface CallState {
  phase: CallPhase
  /** `null` until the server has named the call (an invitation still on its way). */
  callId: string | null
  /** The other person. */
  peer: NamedUser | null
  conversationId: string | null
  /** What the caller asked for. */
  media: CallMedia
  /** The user made this call. */
  outgoing: boolean
  micOn: boolean
  /** Whether this side's camera is on (it is what is sent, unless the screen is). */
  cameraOn: boolean
  /** The camera in use looks away from the user (a phone's back camera): its picture is not shown mirrored. */
  facingAway: boolean
  /** This side sends its screen instead of its camera. */
  sharing: boolean
  /** What picture the other side says it sends; `null` until it has said. */
  peerPicture: Picture | null
  /** The path between the two devices is slow or losing a lot. */
  poor: boolean
  minimised: boolean
  /** When the two devices first reached each other: what the timer counts from. */
  connectedAt: number | null
  /** The path between the two devices broke, and is being found again. */
  reconnecting: boolean
  /** The other device's connection to the server is down; it has a while to come back. */
  peerAway: boolean
  /** Once `ended`: why. */
  outcome: CallOutcome | null
  /** The server's own words, for `refused`. */
  message: string | null
}

export const initialCallState: CallState = {
  phase: 'idle', callId: null, peer: null, conversationId: null, media: 'audio', outgoing: false,
  micOn: true, cameraOn: false, facingAway: false, sharing: false, peerPicture: null, poor: false,
  minimised: false, connectedAt: null, reconnecting: false, peerAway: false, outcome: null, message: null,
}

export type CallAction =
  /** The user calls someone. */
  | { type: 'calling'; peer: NamedUser; media: CallMedia; conversationId: string }
  /** The server took the invitation: the other side is ringing. */
  | { type: 'invited'; callId: string }
  | { type: 'incoming'; call: CallIncomingPayload }
  /** The user accepts, with or without picture. */
  | { type: 'answering'; video: boolean }
  /** The other person accepted. */
  | { type: 'accepted'; callId: string }
  /** The two devices reach each other (again). */
  | { type: 'connected'; at: number }
  /** They stopped reaching each other. */
  | { type: 'interrupted' }
  | { type: 'peer'; callId: string; connected: boolean }
  /** The server says the call is over. */
  | { type: 'ended'; callId: string; reason: CallEndReason }
  /** It cannot go on, for a reason found here. */
  | { type: 'failed'; outcome: CallOutcome; message?: string }
  /** The user hung up, declined or cancelled: there is nothing to tell them. */
  | { type: 'hungUp' }
  | { type: 'dismissed' }
  | { type: 'micToggled' }
  | { type: 'cameraToggled' }
  /** There turned out to be no camera to send from. */
  | { type: 'cameraUnavailable' }
  | { type: 'minimised'; minimised: boolean }
  /** Which way the camera now in use looks. */
  | { type: 'facing'; away: boolean }
  /** The screen is being sent, or no longer. */
  | { type: 'sharing'; sharing: boolean }
  | { type: 'peerPicture'; picture: Picture }
  | { type: 'quality'; poor: boolean }

/** In a call, or on the way into or out of one: no other can begin. */
export const isEngaged = (state: CallState) => state.phase !== 'idle' && state.phase !== 'ended'

const over = (state: CallState, outcome: CallOutcome, message: string | null = null): CallState => ({
  ...initialCallState, phase: 'ended', peer: state.peer, conversationId: state.conversationId, media: state.media,
  outgoing: state.outgoing, outcome, message,
})

// What the user need not be told: they did it themselves, or it is not their call any more.
const QUIET: readonly CallOutcome[] = ['cancelled', 'answered-elsewhere']

export const callReducer = (state: CallState, action: CallAction): CallState => {
  switch (action.type) {
    case 'calling':
      if (isEngaged(state)) return state
      return {
        ...initialCallState, phase: 'outgoing', peer: action.peer, conversationId: action.conversationId,
        media: action.media, outgoing: true, cameraOn: action.media === 'video',
      }

    case 'invited':
      return state.phase === 'outgoing' && state.callId === null ? { ...state, callId: action.callId } : state

    case 'incoming':
      // (The server never rings someone who is in a call; if it did, the call they are in comes first.)
      if (isEngaged(state)) return state
      return {
        ...initialCallState, phase: 'incoming', callId: action.call.callId, peer: action.call.from,
        conversationId: action.call.conversationId, media: action.call.media,
      }

    case 'answering':
      return state.phase === 'incoming' ? { ...state, phase: 'connecting', cameraOn: action.video } : state

    case 'accepted':
      return state.phase === 'outgoing' && state.callId === action.callId ? { ...state, phase: 'connecting' } : state

    case 'connected':
      if (state.phase === 'connecting') return { ...state, phase: 'active', connectedAt: action.at, reconnecting: false }
      return state.phase === 'active' && state.reconnecting ? { ...state, reconnecting: false } : state

    case 'interrupted':
      return state.phase === 'active' && !state.reconnecting ? { ...state, reconnecting: true } : state

    case 'peer':
      return isEngaged(state) && state.callId === action.callId && state.peerAway === action.connected
        ? { ...state, peerAway: !action.connected }
        : state

    case 'ended':
      if (!isEngaged(state) || state.callId !== action.callId) return state
      // While it only rang here there is nothing to say: the conversation has the line.
      if (state.phase === 'incoming' || QUIET.includes(action.reason)) return initialCallState
      return over(state, action.reason)

    case 'failed':
      return isEngaged(state) ? over(state, action.outcome, action.message ?? null) : state

    case 'hungUp':
      return isEngaged(state) ? initialCallState : state

    case 'dismissed':
      return state.phase === 'ended' ? initialCallState : state

    case 'micToggled':
      return isEngaged(state) ? { ...state, micOn: !state.micOn } : state

    case 'cameraToggled':
      return isEngaged(state) ? { ...state, cameraOn: !state.cameraOn } : state

    case 'cameraUnavailable':
      return isEngaged(state) && state.cameraOn ? { ...state, cameraOn: false } : state

    case 'minimised':
      return isEngaged(state) && state.minimised !== action.minimised ? { ...state, minimised: action.minimised } : state

    case 'facing':
      return isEngaged(state) && state.facingAway !== action.away ? { ...state, facingAway: action.away } : state

    case 'sharing':
      return isEngaged(state) && state.sharing !== action.sharing ? { ...state, sharing: action.sharing } : state

    case 'peerPicture':
      return isEngaged(state) && state.peerPicture !== action.picture ? { ...state, peerPicture: action.picture } : state

    case 'quality':
      return state.phase === 'active' && state.poor !== action.poor ? { ...state, poor: action.poor } : state
  }
}

/** What the call is doing right now, in a few words, for under the other person's name. */
export const callStatusLine = (state: CallState): string => {
  switch (state.phase) {
    case 'outgoing':
      return state.callId === null ? 'Calling…' : 'Ringing…'
    case 'incoming':
      return state.media === 'video' ? 'Incoming video call' : 'Incoming voice call'
    case 'connecting':
      return 'Connecting…'
    case 'active':
      return state.peerAway || state.reconnecting ? 'Reconnecting…' : ''
    default:
      return ''
  }
}

/** What picture this side is sending. */
export const pictureSent = (state: Pick<CallState, 'sharing' | 'cameraOn'>): Picture =>
  state.sharing ? 'screen' : state.cameraOn ? 'camera' : 'none'

/** Why the call is over, in plain words. */
export const callOutcomeLine = (state: Pick<CallState, 'outcome' | 'message' | 'peer'>): string => {
  const name = state.peer?.username ?? 'They'
  switch (state.outcome) {
    case 'ended':
      return 'Call ended'
    case 'declined':
      return `${name} declined the call`
    case 'missed':
      return `${name} did not answer`
    case 'unavailable':
      return `${name} cannot be reached right now`
    case 'dnd':
      return `${name} has asked not to be disturbed`
    case 'busy':
      return `${name} is in another call`
    case 'in-call':
      return 'You are already in a call on another device'
    case 'failed':
      return 'The call was cut off: the connection was lost'
    case 'unreachable':
      return `Could not connect to ${name}. One of your networks may be blocking calls`
    case 'permission':
      return 'Your browser is not allowed to use the microphone or camera. Allow it for this site and call again'
    case 'no-device':
      return 'No microphone was found on this device'
    case 'refused':
      return state.message ?? 'The call could not be made'
    default:
      return 'Call ended'
  }
}

/** "0:07", "12:34", "1:02:03". */
export const callClock = (elapsedMs: number): string => {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const [hours, minutes, seconds] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
  const two = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
}
