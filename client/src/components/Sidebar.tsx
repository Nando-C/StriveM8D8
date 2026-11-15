import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { UserAvatar } from '@/components/UserAvatar'
import type { Conversation } from '@/lib/chatState'
import { cn } from '@/lib/utils'
import type { OnlineUser } from '@/types/protocol'

interface SidebarProps {
  username: string
  users: OnlineUser[]
  selected: string | null
  /** Whether the selected user is currently online (they stay listed while selected). */
  selectedOnline: boolean
  conversations: Record<string, Conversation>
  onSelect: (username: string) => void
  className?: string
}

export function Sidebar({
  username,
  users,
  selected,
  selectedOnline,
  conversations,
  onSelect,
  className,
}: SidebarProps) {
  // A selected user who went offline stays in the list, so the open conversation
  // does not lose its entry.
  const names = users.map(user => user.username).sort((a, b) => a.localeCompare(b))
  const listed = selected !== null && !selectedOnline && !names.includes(selected) ? [...names, selected] : names

  return (
    <aside className={cn('flex min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground', className)}>
      <div className="flex items-center gap-3 border-b p-4">
        <UserAvatar username={username} className="size-9" />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Signed in as</p>
          <p className="truncate font-medium">{username}</p>
        </div>
      </div>
      <nav aria-label="People online" className="flex min-h-0 flex-1 flex-col">
        <h2 className="flex items-center justify-between px-4 pt-4 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Online
          <span aria-hidden="true">{names.length}</span>
        </h2>
        <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
          {listed.length === 0 ? (
            <div className="px-4 py-2 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Nobody else is here yet</p>
              <p className="mt-1">
                Open this page in a second tab and join with another name to try a conversation.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1 px-2 pb-2">
              {listed.map(name => {
                const online = names.includes(name)
                const unread = conversations[name]?.unread ?? 0
                const current = name === selected
                return (
                  <li key={name}>
                    <button
                      type="button"
                      onClick={() => onSelect(name)}
                      aria-current={current ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm outline-none',
                        'transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50',
                        current && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                      )}
                    >
                      <UserAvatar username={name} online={online} className="size-8" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cn('truncate', unread > 0 && 'font-semibold')}>{name}</span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {online ? 'Online' : 'Offline'}
                        </span>
                      </span>
                      {unread > 0 && (
                        <Badge>
                          <span aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
                          <span className="sr-only">
                            {unread} unread {unread === 1 ? 'message' : 'messages'}
                          </span>
                        </Badge>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </ScrollArea>
      </nav>
    </aside>
  )
}
