import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, CheckCheck, CircleAlert, LoaderCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { UserAvatar } from '@/components/UserAvatar'
import type { Thread } from '@/lib/chatState'
import { describeGroupEvent } from '@/lib/groupEvents'
import type { LocalMessage } from '@/lib/messages'
import { comparePositions, positionOf } from '@/lib/positions'
import { TICK_LABELS, receiptsOf, tickOf, type Tick } from '@/lib/ticks'
import { formatDay, formatTime, isSameDay } from '@/lib/format'
import { fade, messageIn } from '@/lib/motion'
import { cn } from '@/lib/utils'

interface MessageListProps {
  /** What the conversation is called: the other person, or the group. */
  title: string
  thread: Thread
  /** The logged-in user, to work out how far their own messages have got. */
  ownUserId: string | null
  /** A group: messages say who wrote them, and what happened to the group is shown in line. */
  group?: boolean
  /** The user was added to the group after it began. */
  joinedLater?: boolean
  /** Ask for the messages before the oldest one shown. */
  onLoadEarlier: () => void
  /** Whether the end of the conversation is on screen — the newest message can be read. */
  onAtEndChange: (atEnd: boolean) => void
}

// One tick: saved. Two: on the other person's device. Two, coloured: seen. The number of
// ticks carries the difference as well as the colour, and each has its name for screen readers.
function Ticks({ tick }: { tick: Tick }) {
  const Icon = tick === 'sent' ? Check : CheckCheck
  return (
    <>
      <Icon aria-hidden="true" data-tick={tick} className={cn('size-3.5', tick === 'seen' && 'text-sky-500')} />
      <span className="sr-only">{TICK_LABELS[tick]}</span>
    </>
  )
}

/** In a group, who a message has reached: names, already put in a line each. */
interface Receipts {
  seenBy: string
  deliveredTo: string
}

// In a group the ticks speak for everyone at once; pressing them says who.
function GroupTicks({ tick, receipts }: { tick: Tick; receipts: Receipts }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${TICK_LABELS[tick]} — show who has seen this`}
        className="flex items-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Ticks tick={tick} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 text-xs">
        {receipts.seenBy === '' && receipts.deliveredTo === '' ? (
          <p className="text-muted-foreground">Not delivered to anyone yet.</p>
        ) : (
          <dl className="flex flex-col gap-2">
            {receipts.seenBy !== '' && (
              <div>
                <dt className="font-medium">Seen by</dt>
                <dd className="text-muted-foreground">{receipts.seenBy}</dd>
              </div>
            )}
            {receipts.deliveredTo !== '' && (
              <div>
                <dt className="font-medium">Delivered to</dt>
                <dd className="text-muted-foreground">{receipts.deliveredTo}</dd>
              </div>
            )}
          </dl>
        )}
      </PopoverContent>
    </Popover>
  )
}

function MessageStatus({ message, tick, seenBy, deliveredTo }: { message: LocalMessage; tick: Tick } & Partial<Receipts>) {
  if (message.status === 'pending') {
    return (
      <>
        <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
        Sending…
      </>
    )
  }
  if (message.status === 'failed') {
    return (
      <>
        <CircleAlert aria-hidden="true" className="size-3" />
        Not sent — {message.error ?? 'unknown error'}
      </>
    )
  }
  return (
    <>
      <time dateTime={new Date(message.timestamp).toISOString()}>{formatTime(message.timestamp)}</time>
      {message.own &&
        (seenBy === undefined || deliveredTo === undefined ? (
          <Ticks tick={tick} />
        ) : (
          <GroupTicks tick={tick} receipts={{ seenBy, deliveredTo }} />
        ))}
    </>
  )
}

interface MessageProps {
  message: LocalMessage
  /** How far it has got, if it is the user's own. */
  tick: Tick
  /** Arrived while this list was on screen: ease it in. Otherwise it is simply there. */
  animateIn: boolean
  /** Groups, someone else's message: 'named' starts a run of theirs, 'continued' carries one on. */
  sender?: 'named' | 'continued'
  /** Groups, the user's own message: who has seen it and who has only received it. Strings, so the row stays memoised. */
  seenBy?: string
  deliveredTo?: string
  /** What a system message says, in words. */
  line?: string
}

// Drawn again only when something about this message changes: a conversation can hold
// hundreds, and every event in it (and every change of anyone's presence) reaches the list.
const Message = memo(function Message({ message, tick, animateIn, sender, seenBy, deliveredTo, line }: MessageProps) {
  // Something that happened to the group: a quiet line across the middle, nobody's bubble.
  if (line !== undefined) {
    return (
      <motion.li
        variants={fade}
        initial={animateIn ? 'hidden' : false}
        animate="visible"
        data-system="true"
        className="py-1 text-center text-xs text-muted-foreground"
      >
        <p data-bubble="system">{line}</p>
      </motion.li>
    )
  }
  const bubble = (
    <p
      data-bubble="message"
      className={cn(
        // wrap-anywhere: a long word with no spaces must wrap instead of widening the page.
        'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap',
        'transition-[opacity,background-color,color] duration-200',
        message.own ? 'rounded-br-md bg-primary text-primary-foreground' : 'rounded-bl-md bg-muted',
        message.status === 'pending' && 'opacity-60',
        message.status === 'failed' && 'bg-destructive/10 text-destructive',
      )}
    >
      {message.text}
    </p>
  )
  return (
    <motion.li
      variants={messageIn(message.own)}
      initial={animateIn ? 'hidden' : false}
      animate="visible"
      className={cn(
        'flex flex-col gap-1',
        message.own ? 'items-end' : 'items-start',
        // A run of one person's messages sits closer together.
        sender === 'continued' && '-mt-1.5',
      )}
    >
      <span className="sr-only">{message.own ? 'You' : message.fromName}:</span>
      {sender === 'named' && (
        // (Said for screen readers just above, on every message.)
        <span aria-hidden="true" data-sender="true" className="pl-9 text-xs font-medium text-muted-foreground">
          {message.fromName}
        </span>
      )}
      {sender === undefined ? (
        bubble
      ) : (
        <div className="flex w-full items-end gap-2">
          {sender === 'named' ? (
            <UserAvatar username={message.fromName} className="size-7" />
          ) : (
            <span aria-hidden="true" className="w-7 shrink-0" />
          )}
          {bubble}
        </div>
      )}
      <p
        className={cn(
          'flex max-w-[80%] items-center gap-1 px-1 text-xs',
          sender !== undefined && 'pl-10',
          message.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {/* The status line cross-fades as a message goes from sending to sent or failed. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            // Keyed by what it says, so each step — sending, sent, delivered, seen — fades in.
            key={message.status === 'sent' ? tick : message.status}
            variants={fade}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="flex items-center gap-1"
          >
            <MessageStatus message={message} tick={tick} seenBy={seenBy} deliveredTo={deliveredTo} />
          </motion.span>
        </AnimatePresence>
      </p>
    </motion.li>
  )
})

export function MessageList({
  title, thread, ownUserId, group = false, joinedLater = false, onLoadEarlier, onAtEndChange,
}: MessageListProps) {
  const root = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const divider = useRef<HTMLLIElement>(null)
  // Messages that arrive after this moment animate in; history and anything already
  // there when the conversation was opened does not — a long conversation appears as
  // one block, never as a hundred staggered entrances.
  const [openedAt] = useState(() => Date.now())
  const { messages, error, hasMore, loadingEarlier, unreadFrom } = thread
  const newest = messages.at(-1)?.key
  const oldest = messages[0]?.key

  // The first message from someone else after where reading left off gets the
  // "New messages" line above it.
  const firstUnread =
    unreadFrom === undefined
      ? undefined
      : messages.find(
          message =>
            !message.own && message.kind !== 'system' && message.id !== null && comparePositions(positionOf({ id: message.id, timestamp: message.timestamp }), unreadFrom) > 0,
        )?.key

  const viewport = () => root.current?.querySelector<HTMLElement>('[data-slot=scroll-area-viewport]') ?? null

  // Watch whether the end of the conversation is on screen. Scrolled up to read older
  // messages, the newest ones are not being read, however visible the page is.
  useEffect(() => {
    const scroller = root.current?.querySelector<HTMLElement>('[data-slot=scroll-area-viewport]') ?? null
    if (end.current === null || scroller === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => onAtEndChange(entries.some(entry => entry.isIntersecting)),
      // A little slack: a pixel or two short of the very end is still "at the end".
      { root: scroller, rootMargin: '0px 0px 48px 0px' },
    )
    observer.observe(end.current)
    return () => observer.disconnect()
  }, [onAtEndChange])
  const seen = useRef<{ newest?: string; oldest?: string; count: number; height: number }>({ count: 0, height: 0 })

  // Where to be after the list changes:
  // - opening, or the first messages arriving: at the "New messages" line if there is one,
  //   otherwise at the newest message;
  // - a new message at the end: follow it (smoothly, if it is just the one);
  // - earlier messages added above: stay exactly where the reader was.
  // A layout effect, so that the last case is corrected before anything is painted.
  useLayoutEffect(() => {
    const before = seen.current
    const scroller = viewport()
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (before.count === 0 && messages.length > 0 && divider.current !== null) {
      divider.current.scrollIntoView({ block: 'center', behavior: 'instant' })
    } else if (newest !== before.newest || before.count === 0) {
      const single = before.count > 0 && messages.length - before.count === 1
      end.current?.scrollIntoView({ block: 'end', behavior: single && !reduceMotion ? 'smooth' : 'instant' })
    } else if (oldest !== before.oldest && scroller !== null) {
      scroller.scrollTop += scroller.scrollHeight - before.height
    }
    seen.current = { newest, oldest, count: messages.length, height: scroller?.scrollHeight ?? 0 }
  }, [newest, oldest, messages.length])

  return (
    // The scroll area's inner wrapper is laid out as a table, which grows to fit its
    // widest content; forcing it to a block keeps everything within the viewport width.
    <ScrollArea ref={root} className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
        {hasMore && (
          <Button variant="ghost" size="sm" className="self-center" onClick={onLoadEarlier} disabled={loadingEarlier}>
            {loadingEarlier && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
          </Button>
        )}
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>Could not load earlier messages: {error}</AlertDescription>
          </Alert>
        )}
        {joinedLater && !hasMore && (
          <p className="py-1 text-center text-xs text-muted-foreground">
            You were added to this group here. Earlier messages are not shown.
          </p>
        )}
        {messages.length === 0 && error === null && !joinedLater && (
          <motion.div
            variants={fade}
            initial="hidden"
            animate="visible"
            className="py-16 text-center text-sm text-muted-foreground"
          >
            <p className="font-medium text-foreground">No messages yet</p>
            <p className="mt-1">Say hello to {title} — your conversation is saved, so it will be here next time.</p>
          </motion.div>
        )}
        {/* role="log" makes screen readers announce messages as they are added. */}
        <ul role="log" aria-label={`Conversation with ${title}`} className="flex flex-col gap-3">
          {messages.map((message, index) => {
            const previous = messages[index - 1]
            const startsDay = previous === undefined || !isSameDay(previous.timestamp, message.timestamp)
            const system = message.kind === 'system'
            const sameSender =
              !startsDay && previous !== undefined && previous.kind !== 'system' && previous.from === message.from
            const receipts =
              group && message.own && message.status === 'sent' && thread.summary !== null && ownUserId !== null
                ? receiptsOf(message, thread.summary, ownUserId)
                : null
            return (
              <Fragment key={message.key}>
                {startsDay && (
                  <li aria-hidden="true" className="py-2 text-center text-xs text-muted-foreground">
                    {formatDay(message.timestamp)}
                  </li>
                )}
                {message.key === firstUnread && (
                  <li
                    ref={divider}
                    role="separator"
                    aria-label="New messages"
                    className="flex items-center gap-3 py-1 text-xs font-medium text-primary before:h-px before:flex-1 before:bg-primary/40 after:h-px after:flex-1 after:bg-primary/40"
                  >
                    New messages
                  </li>
                )}
                <Message
                  message={message}
                  tick={message.own ? tickOf(message, thread.summary, ownUserId) : 'sent'}
                  animateIn={message.arrivedAt !== null && message.arrivedAt >= openedAt}
                  line={system ? describeGroupEvent(message.data, ownUserId) : undefined}
                  sender={!group || system || message.own ? undefined : sameSender ? 'continued' : 'named'}
                  seenBy={receipts?.seenBy.join(', ')}
                  deliveredTo={receipts?.deliveredTo.join(', ')}
                />
              </Fragment>
            )
          })}
        </ul>
        <div ref={end} className="h-px" />
      </div>
    </ScrollArea>
  )
}
