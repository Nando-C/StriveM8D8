import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Maximize2, Mic, MicOff, Minimize2, MonitorUp, PhoneOff, SwitchCamera, Video, VideoOff } from 'lucide-react'
import { CallSettings } from '@/components/call/CallSettings'
import { Button } from '@/components/ui/button'
import { UserAvatar } from '@/components/UserAvatar'
import type { Call } from '@/hooks/useCall'
import { callClock, callStatusLine } from '@/lib/call/callState'
import { isHandheld } from '@/lib/call/devices'
import { fade } from '@/lib/motion'
import { cn } from '@/lib/utils'

// A stream is given to its element, not written in its markup.
const useStream = (stream: MediaStream | null) => {
  const element = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (element.current !== null && element.current.srcObject !== stream) element.current.srcObject = stream
  }, [stream])
  return element
}

const hasPicture = (stream: MediaStream | null) => stream !== null && stream.getVideoTracks().length > 0

// Sound goes to the speaker the user chose, where the browser lets it be sent to one.
const useSpeaker = (element: React.RefObject<HTMLVideoElement | null>, speaker: string | undefined) => {
  useEffect(() => {
    const playing = element.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null
    // (One that is no longer there is refused: the sound stays where it was.)
    void playing?.setSinkId?.(speaker ?? '').catch(() => {})
  }, [element, speaker])
}

/** How long the call has lasted, counted here once a second. */
function Clock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const ticking = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(ticking)
  }, [])
  return <time role="timer" aria-label="Call length">{callClock(now - since)}</time>
}

const ROUND = 'size-12 rounded-full'
const QUIET = 'bg-white/15 text-white hover:bg-white/25 hover:text-white'
const OFF = 'bg-white text-neutral-900 hover:bg-white/85 hover:text-neutral-900'

/**
 * The call the user is in, from the moment they make or accept it: the other person's
 * picture filling the screen (or their avatar, without one), the user's own in a corner,
 * and the controls. It can be shrunk to a tile in the corner, to carry on chatting.
 */
export function CallView({ call }: { call: Call }) {
  const { state, localStream, remoteStream } = call
  const remote = useStream(remoteStream)
  const local = useStream(localStream)
  useSpeaker(remote, call.chosen.speaker)
  const name = state.peer?.username ?? ''
  const small = state.minimised
  // (A camera turned off still sends — black. The other end says when that is so.)
  const remotePicture = hasPicture(remoteStream) && state.peerPicture !== 'none'
  const localPicture = hasPicture(localStream) && state.cameraOn && !state.sharing
  const status = callStatusLine(state)
  const active = state.phase === 'active'

  return (
    <motion.section
      variants={fade}
      initial="hidden"
      animate="visible"
      exit="exit"
      aria-label={`Call with ${name}`}
      data-call={state.phase}
      className={cn(
        'fixed z-40 flex flex-col overflow-hidden bg-neutral-950 text-white',
        small ? 'right-3 bottom-3 h-40 w-56 rounded-xl shadow-xl ring-1 ring-white/15 sm:right-4 sm:bottom-4' : 'inset-0',
      )}
    >
      {/* Always there, seen or not: it is also what plays the other person's voice. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a live call: there are no captions to offer */}
      <video
        ref={remote}
        autoPlay
        playsInline
        data-stream="remote"
        aria-label={`${name}’s video`}
        className={cn('absolute inset-0 size-full object-contain', !remotePicture && 'invisible')}
      />
      {!remotePicture && (
        <div className="absolute inset-0 flex items-center justify-center">
          <UserAvatar username={name} className={small ? 'size-12' : 'size-28 text-4xl'} />
        </div>
      )}

      <header className={cn('relative flex items-center gap-2 bg-gradient-to-b from-black/60 to-transparent', small ? 'p-2' : 'p-4')}>
        <div className="min-w-0 flex-1">
          <h2 className={cn('truncate font-medium', small ? 'text-sm' : 'text-lg')}>{name}</h2>
          <p role="status" className={cn('truncate text-white/80', small ? 'text-xs' : 'text-sm')}>
            {status !== '' ? status : state.connectedAt !== null && <Clock since={state.connectedAt} />}
            {status === '' && state.poor && ' · Poor connection'}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/15 hover:text-white"
          onClick={() => call.setMinimised(!small)}
        >
          {small ? <Maximize2 aria-hidden="true" /> : <Minimize2 aria-hidden="true" />}
          <span className="sr-only">{small ? 'Back to the call' : 'Minimise the call'}</span>
        </Button>
      </header>

      {state.sharing && !small && (
        <p className="relative mx-auto mt-2 rounded-full bg-black/60 px-3 py-1 text-sm">You are sharing your screen</p>
      )}

      {/* The user's own picture: mirrored, as a mirror would show it — unless the camera looks the other way. */}
      <video
        ref={local}
        autoPlay
        playsInline
        muted
        data-stream="local"
        aria-label="Your video"
        className={cn(
          'absolute rounded-lg bg-neutral-800 object-cover shadow-lg ring-1 ring-white/20',
          !state.facingAway && '-scale-x-100',
          small ? 'hidden' : 'right-4 bottom-28 h-36 w-28 sm:h-32 sm:w-44',
          !localPicture && 'hidden',
        )}
      />

      <div className={cn('relative mt-auto flex items-center justify-center bg-gradient-to-t from-black/60 to-transparent', small ? 'gap-2 p-2' : 'gap-4 p-6')}>
        {!small && (
          <>
            <Button variant="ghost" size="icon-lg" aria-pressed={!state.micOn} className={cn(ROUND, state.micOn ? QUIET : OFF)} onClick={call.toggleMic}>
              {state.micOn ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}
              <span className="sr-only">{state.micOn ? 'Mute the microphone' : 'Unmute the microphone'}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon-lg"
              aria-pressed={!state.cameraOn}
              // (While the screen is what is sent, the camera has nothing to turn on or off.)
              disabled={state.sharing}
              title={state.sharing ? 'Stop sharing your screen first' : undefined}
              className={cn(ROUND, state.cameraOn ? QUIET : OFF)}
              onClick={() => void call.toggleCamera()}
            >
              {state.cameraOn ? <Video aria-hidden="true" /> : <VideoOff aria-hidden="true" />}
              <span className="sr-only">{state.cameraOn ? 'Turn the camera off' : 'Turn the camera on'}</span>
            </Button>
            {localPicture && call.devices.camera.length > 1 && isHandheld() && (
              <Button variant="ghost" size="icon-lg" className={cn(ROUND, QUIET)} onClick={() => void call.flipCamera()}>
                <SwitchCamera aria-hidden="true" />
                <span className="sr-only">Switch camera</span>
              </Button>
            )}
            {active && call.canShare && (
              <Button variant="ghost" size="icon-lg" aria-pressed={state.sharing} className={cn(ROUND, state.sharing ? OFF : QUIET)} onClick={() => void call.toggleSharing()}>
                <MonitorUp aria-hidden="true" />
                <span className="sr-only">{state.sharing ? 'Stop sharing your screen' : 'Share your screen'}</span>
              </Button>
            )}
            <CallSettings devices={call.devices} chosen={call.chosen} onChoose={call.choose} className={cn(ROUND, QUIET)} />
          </>
        )}
        <Button variant="destructive" size="icon-lg" className={cn('rounded-full', small ? 'size-9' : 'size-12')} onClick={call.hangUp}>
          <PhoneOff aria-hidden="true" />
          <span className="sr-only">{state.phase === 'outgoing' ? 'Cancel the call' : 'Hang up'}</span>
        </Button>
      </div>
    </motion.section>
  )
}
