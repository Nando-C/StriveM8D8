import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { CallView } from '@/components/call/CallView'
import { IncomingCall } from '@/components/call/IncomingCall'
import { Button } from '@/components/ui/button'
import type { Call } from '@/hooks/useCall'
import { callOutcomeLine } from '@/lib/call/callState'
import { notice } from '@/lib/motion'

/** Whatever of a call is on screen right now, over the rest of the app: ringing, the call itself, or why it ended. */
export function CallLayer({ call }: { call: Call }) {
  const { state } = call
  return (
    <>
      {state.phase === 'incoming' && state.peer !== null && (
        <IncomingCall from={state.peer.username} media={state.media} onAccept={video => void call.accept(video)} onDecline={call.hangUp} />
      )}
      <AnimatePresence>
        {(state.phase === 'outgoing' || state.phase === 'connecting' || state.phase === 'active') && (
          <CallView
            key="call"
            state={state}
            localStream={call.localStream}
            remoteStream={call.remoteStream}
            onHangUp={call.hangUp}
            onToggleMic={call.toggleMic}
            onToggleCamera={() => void call.toggleCamera()}
            onMinimise={call.setMinimised}
          />
        )}
        {state.phase === 'ended' && (
          <motion.div
            key="outcome"
            variants={notice}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="alert"
            className="fixed inset-x-3 bottom-20 z-40 mx-auto flex max-w-sm items-start gap-2 rounded-xl border bg-card p-3 text-sm shadow-lg"
          >
            <p className="min-w-0 flex-1 py-1">{callOutcomeLine(state)}</p>
            <Button variant="ghost" size="icon-sm" onClick={call.dismiss}>
              <X aria-hidden="true" />
              <span className="sr-only">Close</span>
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
