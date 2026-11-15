import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface MessageComposerProps {
  recipient: string
  /** Logged in, connected, and the recipient is online. */
  canSend: boolean
  /** Shown in place of the placeholder when sending is not possible. */
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
    <form onSubmit={submit} className="flex gap-2 border-t p-4">
      <Input
        aria-label={`Message ${recipient}`}
        placeholder={blockedReason ?? `Message ${recipient}`}
        autoComplete="off"
        maxLength={2000}
        value={text}
        onChange={event => setText(event.target.value)}
        disabled={!canSend}
      />
      <Button type="submit" disabled={!canSend || trimmed === ''}>
        Send
      </Button>
    </form>
  )
}
