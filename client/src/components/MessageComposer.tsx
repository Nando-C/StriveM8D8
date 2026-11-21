import { useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { Paperclip, SendHorizontal } from 'lucide-react'
import { DraftFiles } from '@/components/files/DraftFiles'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { DraftFile } from '@/hooks/useDraftFiles'
import type { Attachment } from '@/types/protocol'

/** The files being attached to the message, and what can be done with them (see useDraftFiles). */
export interface ComposerFiles {
  /** Why files cannot be attached by this user, if they cannot: shown on the button. `null`: they can. */
  unavailable: string | null
  drafts: DraftFile[]
  notice: string | null
  ready: boolean
  full: boolean
  attachments: Attachment[]
  add: (files: File[]) => void
  remove: (key: string) => void
  restart: (key: string, original: boolean) => void
  sent: () => void
}

interface MessageComposerProps {
  recipient: string
  /** Logged in, connected, and the recipient is online. */
  canSend: boolean
  /** Why sending is not possible right now; shown in place of the placeholder. */
  blockedReason: string | null
  onSend: (text: string, attachments: Attachment[]) => void
  /** Absent where the deployment has no file sharing: then there is nothing about files here. */
  files?: ComposerFiles
}

export function MessageComposer({ recipient, canSend, blockedReason, onSend, files }: MessageComposerProps) {
  const [text, setText] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const trimmed = text.trim()
  const drafts = files?.drafts ?? []
  // Words, or files — and every file chosen has to have arrived.
  const sendable = canSend && (drafts.length === 0 ? trimmed !== '' : files?.ready === true)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!sendable) return
    onSend(trimmed, files?.attachments ?? [])
    files?.sent()
    setText('')
  }

  // A picture copied from somewhere, or files copied in a file manager, pasted into the message.
  const paste = (event: ClipboardEvent) => {
    const pasted = [...event.clipboardData.files]
    if (pasted.length === 0 || files === undefined || files.unavailable !== null) return
    event.preventDefault()
    files.add(pasted)
  }

  return (
    <form onSubmit={submit} className="border-t p-3 sm:p-4">
      {drafts.length > 0 && files !== undefined && (
        <DraftFiles drafts={drafts} onRemove={files.remove} onRestart={files.restart} />
      )}
      {files?.notice != null && (
        <p role="status" className="mx-auto w-full max-w-3xl pb-2 text-xs text-muted-foreground">{files.notice}</p>
      )}
      <div className="mx-auto flex w-full max-w-3xl gap-2">
        {files !== undefined && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label="Choose files to send"
              onChange={event => {
                files.add([...(event.target.files ?? [])])
                // (So that choosing the same file again is still a change.)
                event.target.value = ''
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="size-10"
              disabled={!canSend || files.unavailable !== null || files.full}
              title={files.unavailable ?? (files.full ? 'No room for another file in this message' : undefined)}
              onClick={() => picker.current?.click()}
            >
              <Paperclip aria-hidden="true" />
              <span className="sr-only">{files.unavailable ?? 'Attach files'}</span>
            </Button>
          </>
        )}
        <Input
          aria-label={`Message ${recipient}`}
          aria-describedby={blockedReason === null ? undefined : 'composer-blocked'}
          placeholder={blockedReason ?? `Message ${recipient}`}
          autoComplete="off"
          autoFocus
          maxLength={2000}
          value={text}
          onChange={event => setText(event.target.value)}
          onPaste={paste}
          disabled={!canSend}
          className="h-10"
        />
        <Button type="submit" size="icon-lg" className="size-10" disabled={!sendable}>
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
