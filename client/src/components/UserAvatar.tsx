import { Avatar, AvatarBadge, AvatarFallback } from '@/components/ui/avatar'
import { avatarColour, initials } from '@/lib/format'
import { cn } from '@/lib/utils'

interface UserAvatarProps {
  username: string
  /** Shows a presence dot: green when online, grey when not. Omit for no dot. */
  online?: boolean
  className?: string
}

export function UserAvatar({ username, online, className }: UserAvatarProps) {
  return (
    <Avatar className={className}>
      <AvatarFallback className={cn('font-medium', avatarColour(username))}>{initials(username)}</AvatarFallback>
      {online !== undefined && (
        <AvatarBadge className={online ? 'bg-emerald-500' : 'bg-muted-foreground/50'} />
      )}
    </Avatar>
  )
}
