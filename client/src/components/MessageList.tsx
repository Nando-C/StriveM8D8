import { Fragment, useEffect, useRef } from 'react'
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Conversation, LocalMessage } from '@/lib/chatState'
import { formatDay, formatTime, isSameDay } from '@/lib/format'
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

function Message({ message, counterpart }: { message: LocalMessage; counterpart: string }) {
  return (
    <li className={cn('flex flex-col gap-1', message.own ? 'items-end' : 'items-start')}>
      <span className="sr-only">{message.own ? 'You' : counterpart}:</span>
      <p
        className={cn(
          // wrap-anywhere: a long word with no spaces must wrap instead of widening the page.
          'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap',
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
        <MessageStatus message={message} />
      </p>
    </li>
  )
}

export function MessageList({ counterpart, conversation }: MessageListProps) {
  const end = useRef<HTMLDivElement>(null)
  const { messages, error } = conversation
  const newest = messages.at(-1)?.key

  // Keep the newest message in view: when one arrives, and when the conversation opens.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
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
          <div className="py-16 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No messages yet</p>
            <p className="mt-1">Say hello to {counterpart} — your conversation is saved, so it will be here next time.</p>
          </div>
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
                <Message message={message} counterpart={counterpart} />
              </Fragment>
            )
          })}
        </ul>
        <div ref={end} />
      </div>
    </ScrollArea>
  )
}
