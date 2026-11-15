import { Fragment, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Conversation, LocalMessage } from '@/lib/chatState'
import { formatDay, formatTime, isSameDay } from '@/lib/format'
import { fade, messageIn } from '@/lib/motion'
import { cn } from '@/lib/utils'

interface MessageListProps {
  /** The other person in the conversation. */
  counterpart: string
  conversation: Conversation
}

function MessageStatus({ message }: { message: LocalMessage }) {
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
      {message.own && (
        <>
          <Check aria-hidden="true" className="size-3" />
          <span className="sr-only">Sent</span>
        </>
      )}
    </>
  )
}

interface MessageProps {
  message: LocalMessage
  counterpart: string
  /** Arrived while this list was on screen: ease it in. Otherwise it is simply there. */
  animateIn: boolean
}

function Message({ message, counterpart, animateIn }: MessageProps) {
  return (
    <motion.li
      variants={messageIn(message.own)}
      initial={animateIn ? 'hidden' : false}
      animate="visible"
      className={cn('flex flex-col gap-1', message.own ? 'items-end' : 'items-start')}
    >
      <span className="sr-only">{message.own ? 'You' : counterpart}:</span>
      <p
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
      <p
        className={cn(
          'flex max-w-[80%] items-center gap-1 px-1 text-xs',
          message.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {/* The status line cross-fades as a message goes from sending to sent or failed. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={message.status}
            variants={fade}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="flex items-center gap-1"
          >
            <MessageStatus message={message} />
          </motion.span>
        </AnimatePresence>
      </p>
    </motion.li>
  )
}

export function MessageList({ counterpart, conversation }: MessageListProps) {
  const end = useRef<HTMLDivElement>(null)
  const previousCount = useRef<number | null>(null)
  // Messages that arrive after this moment animate in; history and anything already
  // there when the conversation was opened does not — a long conversation appears as
  // one block, never as a hundred staggered entrances.
  const [openedAt] = useState(() => Date.now())
  const { messages, error } = conversation
  const newest = messages.at(-1)?.key

  // Keep the newest message in view: smoothly for a single new message, instantly when
  // the conversation opens or a batch of history lands.
  useEffect(() => {
    const single = previousCount.current !== null && messages.length - previousCount.current === 1
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    end.current?.scrollIntoView({ block: 'end', behavior: single && !reduceMotion ? 'smooth' : 'instant' })
    previousCount.current = messages.length
  }, [newest, messages.length])

  return (
    // The scroll area's inner wrapper is laid out as a table, which grows to fit its
    // widest content; forcing it to a block keeps everything within the viewport width.
    <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>Could not load earlier messages: {error}</AlertDescription>
          </Alert>
        )}
        {messages.length === 0 && error === null && (
          <motion.div
            variants={fade}
            initial="hidden"
            animate="visible"
            className="py-16 text-center text-sm text-muted-foreground"
          >
            <p className="font-medium text-foreground">No messages yet</p>
            <p className="mt-1">Say hello to {counterpart} — your conversation is saved, so it will be here next time.</p>
          </motion.div>
        )}
        {/* role="log" makes screen readers announce messages as they are added. */}
        <ul role="log" aria-label={`Conversation with ${counterpart}`} className="flex flex-col gap-3">
          {messages.map((message, index) => {
            const previous = messages[index - 1]
            const startsDay = previous === undefined || !isSameDay(previous.timestamp, message.timestamp)
            return (
              <Fragment key={message.key}>
                {startsDay && (
                  <li aria-hidden="true" className="py-2 text-center text-xs text-muted-foreground">
                    {formatDay(message.timestamp)}
                  </li>
                )}
                <Message
                  message={message}
                  counterpart={counterpart}
                  animateIn={message.arrivedAt !== null && message.arrivedAt >= openedAt}
                />
              </Fragment>
            )
          })}
        </ul>
        <div ref={end} />
      </div>
    </ScrollArea>
  )
}
