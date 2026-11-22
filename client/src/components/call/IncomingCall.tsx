import { Phone, PhoneOff, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { UserAvatar } from '@/components/UserAvatar'
import type { CallMedia } from '@/types/protocol'

interface IncomingCallProps {
  from: string
  media: CallMedia
  onAccept: (video: boolean) => void
  onDecline: () => void
}

/** Someone is calling: who, and what to do about it. It stays until the call is answered, declined or over. */
export function IncomingCall({ from, media, onAccept, onDecline }: IncomingCallProps) {
  return (
    // (Not closed by pressing outside it or Escape: a call is answered or declined, not brushed away.)
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        className="flex max-w-xs flex-col items-center gap-4 text-center"
        onEscapeKeyDown={event => event.preventDefault()}
        onInteractOutside={event => event.preventDefault()}
      >
        <UserAvatar username={from} className="size-16 text-xl" />
        <div className="flex flex-col gap-1">
          <DialogTitle>{from} is calling</DialogTitle>
          <DialogDescription>{media === 'video' ? 'Video call' : 'Voice call'}</DialogDescription>
        </div>
        <div className="flex w-full flex-col gap-2">
          {media === 'video' ? (
            <>
              <Button onClick={() => onAccept(true)}>
                <Video aria-hidden="true" />
                Accept with video
              </Button>
              <Button variant="secondary" onClick={() => onAccept(false)}>
                <Phone aria-hidden="true" />
                Accept with voice only
              </Button>
            </>
          ) : (
            <Button onClick={() => onAccept(false)}>
              <Phone aria-hidden="true" />
              Accept
            </Button>
          )}
          <Button variant="destructive" onClick={onDecline}>
            <PhoneOff aria-hidden="true" />
            Decline
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
