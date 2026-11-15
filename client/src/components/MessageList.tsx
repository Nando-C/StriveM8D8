import { useEffect, useRef } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Conversation, LocalMessage } from '@/lib/chatState'
import { cn } from '@/lib/utils'

interface MessageListProps {
  conversation: Conversation
}

const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function Message({ message }: { message: LocalMessage }) {
  return (
    <li className={cn('flex flex-col gap-1', message.own ? 'items-end' : 'items-start')}>
      <p
        className={cn(
          'max-w-[75%] rounded-2xl px-3 py-2 text-sm break-words whitespace-pre-wrap',
          message.own ? 'bg-primary text-primary-foreground' : 'bg-muted',
          message.status === 'pending' && 'opacity-60',
          message.status === 'failed' && 'bg-destructive/10 text-destructive',
        )}
      >
        {message.text}
      </p>
      <p className={cn('text-xs', message.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
        {message.status === 'pending' && 'Sending…'}
        {message.status === 'failed' && `Not sent — ${message.error ?? 'unknown error'}`}
        {message.status === 'sent' && formatTime(message.timestamp)}
      </p>
    </li>
  )
}

export function MessageList({ conversation }: MessageListProps) {
  const end = useRef<HTMLDivElement>(null)
  const count = conversation.messages.length

  // Keep the newest message in view.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [count])

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 p-4">
        {conversation.error !== null && (
          <Alert variant="destructive">
            <AlertDescription>Could not load earlier messages: {conversation.error}</AlertDescription>
          </Alert>
        )}
        {count === 0 && conversation.error === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No messages yet. Say hello.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {conversation.messages.map(message => (
              <Message key={message.key} message={message} />
            ))}
          </ul>
        )}
        <div ref={end} />
      </div>
    </ScrollArea>
  )
}
