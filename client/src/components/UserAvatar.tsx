import { Avatar, AvatarBadge, AvatarFallback } from '@/components/ui/avatar'
import { avatarColour, initials } from '@/lib/format'
import { STATUS_LABELS, type Presence } from '@/lib/status'
import { cn } from '@/lib/utils'

interface UserAvatarProps {
  username: string
  /** Shows a mark for how the person appears. Omit for none. */
  presence?: Presence
  /**
   * Also say it in words, for screen readers. For places where nothing else beside the
   * avatar states it; where it is written out next to the avatar, the mark is decoration.
   */
  labelled?: boolean
  className?: string
}

// Each state has its own shape as well as its own colour, so that it can be told apart
// without seeing colour at all: a filled dot, a hollow ring, a dot with a bar across it,
// and an empty, faint ring.
const MARKS: Record<Presence, string> = {
  online: 'bg-emerald-500',
  away: 'border-2 border-amber-500 bg-background',
  dnd: 'bg-red-500 after:h-0.5 after:w-1.5 after:rounded-full after:bg-white',
  offline: 'border-2 border-muted-foreground/40 bg-background',
}

export function UserAvatar({ username, presence, labelled = false, className }: UserAvatarProps) {
  return (
    <Avatar className={className}>
      <AvatarFallback className={cn('font-medium', avatarColour(username))}>{initials(username)}</AvatarFallback>
      {presence !== undefined && (
        <AvatarBadge data-presence={presence} aria-hidden={labelled ? undefined : true} className={MARKS[presence]}>
          {labelled && <span className="sr-only">{STATUS_LABELS[presence]}</span>}
        </AvatarBadge>
      )}
    </Avatar>
  )
}
