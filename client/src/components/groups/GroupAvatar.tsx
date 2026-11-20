import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { avatarColour } from '@/lib/format'
import { cn } from '@/lib/utils'

interface GroupAvatarProps {
  /** The other members' names; the first two are drawn. */
  names: string[]
  className?: string
}

const initial = (name: string) => name.slice(0, 1).toUpperCase()

/** Two small overlapping avatars: a group at a glance, told apart from a person by shape. */
export function GroupAvatar({ names, className }: GroupAvatarProps) {
  const shown = names.slice(0, 2)
  return (
    // Decoration: the group's name is written beside it.
    <span aria-hidden="true" data-slot="group-avatar" className={cn('relative block shrink-0', className)}>
      {shown.map((name, index) => (
        <Avatar
          key={`${index}-${name}`}
          className={cn(
            'absolute size-[64%] ring-2 ring-sidebar',
            shown.length === 1 ? 'inset-0 m-auto' : index === 0 ? 'top-0 left-0' : 'right-0 bottom-0',
          )}
        >
          <AvatarFallback className={cn('text-[0.65rem] font-medium', avatarColour(name))}>{initial(name)}</AvatarFallback>
        </Avatar>
      ))}
    </span>
  )
}
