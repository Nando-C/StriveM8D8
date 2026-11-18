import { useState, type FormEvent } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Field, FormError } from '@/components/account/fields'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  CLEAR_AFTER_CHOICES, CLEAR_AFTER_LABELS, MAX_STATUS_TEXT_LENGTH, clearAfterMinutes, type ClearAfter,
} from '@/lib/status'
import type { Ack, OwnStatus, SetStatusPayload } from '@/types/protocol'

interface StatusDialogProps {
  /** The message there is now, if any. */
  current: string
  onSetStatus: (payload: SetStatusPayload) => Promise<Ack<OwnStatus>>
  onClose: () => void
}

/** A line of the user's own beside their name — "at lunch", "back at two" — and how long it stays. */
export function StatusDialog({ current, onSetStatus, onClose }: StatusDialogProps) {
  const [text, setText] = useState(current)
  const [clearAfter, setClearAfter] = useState<ClearAfter>('never')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (payload: SetStatusPayload) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const answer = await onSetStatus(payload)
    setBusy(false)
    if (answer.ok) onClose()
    else setError(answer.message)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void save({ text: text.trim(), clearAfterMinutes: clearAfterMinutes(clearAfter) })
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Status message</DialogTitle>
          <DialogDescription>Shown beside your name to everyone who can see you.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field
            id="status-text"
            label="Message"
            hint={`${text.trim().length} of ${MAX_STATUS_TEXT_LENGTH} characters`}
            autoComplete="off"
            autoFocus
            maxLength={MAX_STATUS_TEXT_LENGTH}
            placeholder="At lunch, back at two…"
            value={text}
            onChange={event => setText(event.target.value)}
            disabled={busy}
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor="status-clear-after">Clear after</Label>
            <select
              id="status-clear-after"
              value={clearAfter}
              onChange={event => setClearAfter(event.target.value as ClearAfter)}
              disabled={busy}
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
            >
              {CLEAR_AFTER_CHOICES.map(choice => (
                <option key={choice} value={choice}>
                  {CLEAR_AFTER_LABELS[choice]}
                </option>
              ))}
            </select>
          </div>
          <FormError message={error} />
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button type="submit" className="flex-1" disabled={busy || text.trim() === ''}>
              {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              Save
            </Button>
            {current !== '' && (
              <Button type="button" variant="outline" className="flex-1" disabled={busy} onClick={() => void save({ text: '' })}>
                Remove message
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
