import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { AccountMenu, type AccountMenuProps } from '@/components/account/AccountMenu'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { UserAvatar } from '@/components/UserAvatar'
import type { Conversation } from '@/lib/chatState'
import { listItem, pop, transition } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { OnlineUser } from '@/types/protocol'

interface SidebarProps {
  username: string
  /** Everything the account menu needs besides the name. */
  account: Omit<AccountMenuProps, 'username'>
  users: OnlineUser[]
  selected: string | null
  /** Whether the selected user is currently online (they stay listed while selected). */
  selectedOnline: boolean
  conversations: Record<string, Conversation>
  onSelect: (username: string) => void
  className?: string
}

/**
 * One shared highlight that slides between entries instead of blinking.
 *
 * It is dropped as soon as its entry starts leaving the list. An entry that is fading out
 * while still holding the shared highlight keeps Motion waiting for a hand-over that, when
 * the list has no measurable size (hidden on a phone, or in tests), never completes — and
 * the entry would stay in the list indefinitely.
 */
function SelectionHighlight({ current }: { current: boolean }) {
  const present = useIsPresent()
  if (!current || !present) return null
  return (
    <motion.span
      layoutId="selected-person"
      transition={transition.base}
      className="absolute inset-0 -z-10 rounded-lg bg-sidebar-accent"
    />
  )
}

export function Sidebar({
  username,
  account,
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
      <div className="border-b p-2">
        <AccountMenu username={username} {...account} />
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
              {/* People fade in and out, and the rest glide to their new places. popLayout
                  takes a leaving entry out of the flow at once, so nothing waits for it. */}
              <AnimatePresence mode="popLayout" initial={false}>
              {listed.map(name => {
                const online = names.includes(name)
                const unread = conversations[name]?.unread ?? 0
                const current = name === selected
                return (
                  <motion.li
                    key={name}
                    layout
                    variants={listItem}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    transition={transition.base}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(name)}
                      aria-current={current ? 'true' : undefined}
                      className={cn(
                        'relative isolate flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm outline-none',
                        'transition-[background-color,scale] hover:bg-sidebar-accent/60 active:scale-[0.98] motion-reduce:active:scale-100',
                        'focus-visible:ring-3 focus-visible:ring-ring/50',
                        current && 'font-medium text-sidebar-accent-foreground',
                      )}
                    >
                      <SelectionHighlight current={current} />
                      <UserAvatar username={name} online={online} className="size-8" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cn('truncate', unread > 0 && 'font-semibold')}>{name}</span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {online ? 'Online' : 'Offline'}
                        </span>
                      </span>
                      <AnimatePresence initial={false}>
                        {unread > 0 && (
                          // Keyed by the count, so the badge pops again each time it goes up.
                          <motion.span key={unread} variants={pop} initial="hidden" animate="visible" exit="exit">
                            <Badge>
                              <span aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
                              <span className="sr-only">
                                {unread} unread {unread === 1 ? 'message' : 'messages'}
                              </span>
                            </Badge>
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </button>
                  </motion.li>
                )
              })}
              </AnimatePresence>
            </ul>
          )}
        </ScrollArea>
      </nav>
    </aside>
  )
}
