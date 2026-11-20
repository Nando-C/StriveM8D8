import { useState, type FormEvent } from 'react'
import { Shell } from '@/components/account/AccountDialogs'
import { Busy, Field, FormError } from '@/components/account/fields'
import { PeoplePicker } from '@/components/groups/PeoplePicker'
import { Button } from '@/components/ui/button'
import type { Candidate } from '@/lib/chatSelectors'
import { MAX_GROUP_MEMBERS, MAX_GROUP_NAME_LENGTH } from '@/lib/groupEvents'
import { ask } from '@/lib/request'
import { useChosen } from '@/lib/useChosen'
import { useRequest } from '@/lib/useRequest'

interface NewGroupDialogProps {
  candidates: Candidate[]
  /** The group exists: open it. */
  onCreated: (conversationId: string) => void
  onClose: () => void
}

export function NewGroupDialog({ candidates, onCreated, onClose }: NewGroupDialogProps) {
  const [name, setName] = useState('')
  const { chosen, toggle } = useChosen(candidates)
  const { busy, error, run } = useRequest()
  const ready = name.trim() !== '' && chosen.size > 0

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    void run(
      () => ask('createGroup', { name: name.trim(), userIds: [...chosen] }),
      answer => {
        onCreated(answer.conversationId)
        onClose()
      },
    )
  }

  return (
    <Shell
      title="New group"
      description="A conversation for up to 20 people. You will be its admin, and anyone in it can add others."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          id="group-name"
          label="Group name"
          autoFocus
          autoComplete="off"
          maxLength={MAX_GROUP_NAME_LENGTH}
          value={name}
          onChange={event => setName(event.target.value)}
          disabled={busy}
        />
        {/* The user is one of the twenty. */}
        <PeoplePicker id="new-group" candidates={candidates} selected={chosen} onToggle={toggle} max={MAX_GROUP_MEMBERS - 1} disabled={busy} />
        <FormError message={error} />
        <Button type="submit" disabled={!ready || busy}>
          <Busy busy={busy}>Create group</Busy>
        </Button>
      </form>
    </Shell>
  )
}
