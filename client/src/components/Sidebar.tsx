import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Conversation } from '@/lib/chatState'
import type { OnlineUser } from '@/types/protocol'
import { cn } from '@/lib/utils'

interface SidebarProps {
  username: string
  users: OnlineUser[]
  selected: string | null
  /** Whether the selected user is currently online (they stay listed while selected). */
  selectedOnline: boolean
  conversations: Record<string, Conversation>
  onSelect: (username: string) => void
}

export function Sidebar({ username, users, selected, selectedOnline, conversations, onSelect }: SidebarProps) {
  // A selected user who went offline stays in the list, so the open conversation
  // does not lose its entry.
  const names = users.map(user => user.username)
  const listed = selected !== null && !selectedOnline && !names.includes(selected) ? [...names, selected] : names

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="border-b p-4">
        <p className="text-xs text-muted-foreground">Signed in as</p>
        <p className="truncate font-medium">{username}</p>
      </div>
      <h2 className="px-4 pt-4 pb-2 text-xs font-medium text-muted-foreground">Online</h2>
      <ScrollArea className="min-h-0 flex-1">
        {listed.length === 0 ? (
          <p className="px-4 py-2 text-sm text-muted-foreground">Nobody else is online.</p>
        ) : (
          <ul className="flex flex-col gap-1 px-2 pb-2">
            {listed.map(name => {
              const online = names.includes(name)
              const unread = conversations[name]?.unread ?? 0
              return (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => onSelect(name)}
                    aria-current={name === selected ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm outline-none',
                      'hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50',
                      name === selected && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                    )}
                  >
                    <Avatar className="size-7">
                      <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className={cn('min-w-0 flex-1 truncate', !online && 'text-muted-foreground')}>{name}</span>
                    {!online && <span className="text-xs text-muted-foreground">offline</span>}
                    {unread > 0 && (
                      <Badge aria-label={`${unread} unread`}>{unread}</Badge>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </ScrollArea>
    </aside>
  )
}
