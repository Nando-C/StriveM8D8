import { useState, type FormEvent } from 'react'
import { SendHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface MessageComposerProps {
  recipient: string
  /** Logged in, connected, and the recipient is online. */
  canSend: boolean
  /** Why sending is not possible right now; shown in place of the placeholder. */
  blockedReason: string | null
  onSend: (text: string) => void
}

export function MessageComposer({ recipient, canSend, blockedReason, onSend }: MessageComposerProps) {
  const [text, setText] = useState('')
  const trimmed = text.trim()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSend || trimmed === '') return
    onSend(trimmed)
    setText('')
  }

  return (
    <form onSubmit={submit} className="border-t p-3 sm:p-4">
      <div className="mx-auto flex w-full max-w-3xl gap-2">
        <Input
          aria-label={`Message ${recipient}`}
          aria-describedby={blockedReason === null ? undefined : 'composer-blocked'}
          placeholder={blockedReason ?? `Message ${recipient}`}
          autoComplete="off"
          autoFocus
          maxLength={2000}
          value={text}
          onChange={event => setText(event.target.value)}
          disabled={!canSend}
          className="h-10"
        />
        <Button type="submit" size="icon-lg" className="size-10" disabled={!canSend || trimmed === ''}>
          <SendHorizontal aria-hidden="true" />
          <span className="sr-only">Send</span>
        </Button>
      </div>
      {blockedReason !== null && (
        <p id="composer-blocked" className="sr-only">
          You cannot send messages right now: {blockedReason}
        </p>
      )}
    </form>
  )
}
