import { Phone, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CallMedia } from '@/types/protocol'

interface CallButtonsProps {
  /** Why the person cannot be called right now, if they cannot: said on the buttons. */
  unavailable: string | null
  onCall: (media: CallMedia) => void
}

/** The two ways to call the person a conversation is with. */
export function CallButtons({ unavailable, onCall }: CallButtonsProps) {
  const button = (media: CallMedia, label: string, Icon: typeof Phone) => (
    <Button
      variant="ghost"
      size="icon"
      disabled={unavailable !== null}
      title={unavailable ?? label}
      onClick={() => onCall(media)}
    >
      <Icon aria-hidden="true" />
      <span className="sr-only">{unavailable === null ? label : `${label} — ${unavailable}`}</span>
    </Button>
  )
  return (
    <div className="ml-auto flex items-center gap-1">
      {button('audio', 'Voice call', Phone)}
      {button('video', 'Video call', Video)}
    </div>
  )
}
