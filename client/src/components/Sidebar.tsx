import type { ReactNode } from 'react'
import { EyeOff, UsersRound } from 'lucide-react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { AccountMenu, type AccountMenuProps } from '@/components/account/AccountMenu'
import { GroupAvatar } from '@/components/groups/GroupAvatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { UserAvatar } from '@/components/UserAvatar'
import { unreadLabel, type ChatEntry, type PersonEntry } from '@/lib/chatSelectors'
import { listItem, pop, transition } from '@/lib/motion'
import { KIND_LABELS, presenceLine } from '@/lib/status'
import { SCROLL_AREA_ROWS, cn } from '@/lib/utils'

interface SidebarProps {
  username: string
  /** Everything the account menu needs besides the name. */
  account: Omit<AccountMenuProps, 'username'>
  /** The user's conversations, most recent first. */
  chats: ChatEntry[]
  /** Everyone a chat can be started with. */
  people: PersonEntry[]
  /** Whether `people` covers every account, or only who is connected. */
  listsEveryone: boolean
  /** The open conversation's id. */
  selected: string | null
  /** The open conversation's other person, when it is a direct chat. */
  selectedUserId: string | null
  onSelectChat: (conversationId: string) => void
  onSelectPerson: (person: PersonEntry) => void
  /** Opens the dialog that makes a group. */
  onNewGroup: () => void
  className?: string
}

/**
 * One shared highlight that slides between chats instead of blinking.
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
      layoutId="selected-chat"
      transition={transition.base}
      className="absolute inset-0 -z-10 rounded-lg bg-sidebar-accent"
    />
  )
}

const rowClass = (current: boolean) =>
  cn(
    'relative isolate flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm outline-none',
    'transition-[background-color,scale] hover:bg-sidebar-accent/60 active:scale-[0.98] motion-reduce:active:scale-100',
    'focus-visible:ring-3 focus-visible:ring-ring/50',
    current && 'font-medium text-sidebar-accent-foreground',
  )

function Row({ id, children }: { id: string; children: ReactNode }) {
  return (
    <motion.li key={id} layout variants={listItem} initial="hidden" animate="visible" exit="exit" transition={transition.base}>
      {children}
    </motion.li>
  )
}

function SectionHeading({ children, count }: { children: ReactNode; count: number }) {
  return (
    <h2 className="flex items-center justify-between px-4 pt-4 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
      <span aria-hidden="true">{count}</span>
    </h2>
  )
}

function UnreadBadge({ unread }: { unread: number }) {
  return (
    <AnimatePresence initial={false}>
      {unread > 0 && (
        // Keyed by the count, so the badge pops again each time it goes up.
        <motion.span key={unread} variants={pop} initial="hidden" animate="visible" exit="exit">
          <Badge>
            <span aria-hidden="true">{unreadLabel(unread)}</span>
            <span className="sr-only">
              {unread} unread {unread === 1 ? 'message' : 'messages'}
            </span>
          </Badge>
        </motion.span>
      )}
    </AnimatePresence>
  )
}

export function Sidebar({
  username,
  account,
  chats,
  people,
  listsEveryone,
  selected,
  selectedUserId,
  onSelectChat,
  onSelectPerson,
  onNewGroup,
  className,
}: SidebarProps) {
  const peopleLabel = listsEveryone ? 'People' : 'People online'
  // The open chat is highlighted in Chats once it is listed there; until then (nothing
  // has been said in it yet) the person it is with is marked instead.
  const selectedIsListed = chats.some(chat => chat.id === selected)

  return (
    <aside className={cn('flex min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground', className)}>
      <div className="border-b p-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <AccountMenu username={username} {...account} />
          </div>
          <Button variant="ghost" size="icon-lg" onClick={onNewGroup} disabled={!account.online}>
            <UsersRound aria-hidden="true" />
            <span className="sr-only">New group</span>
          </Button>
        </div>
        {account.ownStatus?.status === 'invisible' && (
          // Quiet, but always there: it is easy to forget, and others think you are away.
          <p role="status" className="flex items-center gap-2 px-2 pt-1 pb-1 text-xs text-muted-foreground">
            <EyeOff aria-hidden="true" className="size-3.5" />
            You are invisible: others see you as offline.
          </p>
        )}
      </div>
      <ScrollArea className={cn('min-h-0 flex-1', SCROLL_AREA_ROWS)}>
        {chats.length > 0 && (
          <nav aria-label="Chats">
            <SectionHeading count={chats.length}>Chats</SectionHeading>
            <ul className="flex flex-col gap-1 px-2 pb-2">
              {/* Chats fade in and out, and the rest glide to their new places as the
                  order changes. popLayout takes a leaving entry out of the flow at once. */}
              <AnimatePresence mode="popLayout" initial={false}>
                {chats.map(chat => {
                  const current = chat.id === selected
                  return (
                    <Row key={chat.id} id={chat.id}>
                      <button
                        type="button"
                        onClick={() => onSelectChat(chat.id)}
                        aria-current={current ? 'true' : undefined}
                        className={rowClass(current)}
                      >
                        <SelectionHighlight current={current} />
                        {/* The line below is the last message, so here the mark is also put into words. */}
                        {chat.memberNames === null ? (
                          <UserAvatar username={chat.title} presence={chat.presence ?? undefined} labelled className="size-8" />
                        ) : (
                          <GroupAvatar names={chat.memberNames} className="size-8" />
                        )}
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className={cn('truncate', chat.unread > 0 && 'font-semibold')}>{chat.title}</span>
                          <span className="truncate text-xs font-normal text-muted-foreground">
                            {chat.counterpart?.gone ? (
                              'No longer here'
                            ) : chat.preview === '' ? (
                              chat.presence === null ? '' : presenceLine(undefined, chat.presence, chat.statusText)
                            ) : (
                              <>
                                {chat.previewOwn ? 'You: ' : chat.previewFrom !== null && `${chat.previewFrom}: `}
                                {chat.preview}
                              </>
                            )}
                          </span>
                        </span>
                        <UnreadBadge unread={chat.unread} />
                      </button>
                    </Row>
                  )
                })}
              </AnimatePresence>
            </ul>
          </nav>
        )}
        <nav aria-label={peopleLabel}>
          <SectionHeading count={people.length}>{peopleLabel}</SectionHeading>
          {people.length === 0 ? (
            <div className="px-4 py-2 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Nobody else is here yet</p>
              <p className="mt-1">
                {listsEveryone
                  ? 'When someone else has an account here, they will be listed.'
                  : 'Open this page in a second tab and join with another name to try a conversation.'}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1 px-2 pb-2">
              <AnimatePresence mode="popLayout" initial={false}>
                {people.map(person => {
                  const current = !selectedIsListed && person.userId === selectedUserId
                  const label = KIND_LABELS[person.kind]
                  return (
                    <Row key={person.userId} id={person.userId}>
                      <button
                        type="button"
                        onClick={() => onSelectPerson(person)}
                        aria-current={current ? 'true' : undefined}
                        className={cn(rowClass(current), current && 'bg-sidebar-accent')}
                      >
                        <UserAvatar username={person.username} presence={person.presence} className="size-8" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{person.username}</span>
                          <span className="overflow-hidden text-xs font-normal text-ellipsis whitespace-nowrap text-muted-foreground">
                            {presenceLine(label, person.presence, person.statusText)}
                          </span>
                        </span>
                      </button>
                    </Row>
                  )
                })}
              </AnimatePresence>
            </ul>
          )}
        </nav>
      </ScrollArea>
    </aside>
  )
}
