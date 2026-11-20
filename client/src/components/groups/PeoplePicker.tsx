import { useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { UserAvatar } from '@/components/UserAvatar'
import type { Candidate } from '@/lib/chatSelectors'
import { KIND_LABELS, presenceLine } from '@/lib/status'

interface PeoplePickerProps {
  /** Distinguishes the fields of two pickers that could be on the page together. */
  id: string
  candidates: Candidate[]
  selected: ReadonlySet<string>
  onToggle: (userId: string) => void
  /** How many may be chosen in all. */
  max: number
  disabled?: boolean
}

/** A searchable checklist of people. */
export function PeoplePicker({ id, candidates, selected, onToggle, max, disabled = false }: PeoplePickerProps) {
  const [search, setSearch] = useState('')
  const wanted = search.trim().toLowerCase()
  const matching = candidates.filter(candidate => candidate.username.toLowerCase().includes(wanted))
  const full = selected.size >= max

  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">There is nobody to add yet.</p>
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-search`}>People</Label>
      <Input
        id={`${id}-search`}
        type="search"
        placeholder="Search by name"
        autoComplete="off"
        value={search}
        onChange={event => setSearch(event.target.value)}
        // Enter here is part of searching: it must not submit a form the picker is in.
        onKeyDown={event => event.key === 'Enter' && event.preventDefault()}
      />
      <ScrollArea className="max-h-56 rounded-lg border [&_[data-slot=scroll-area-viewport]]:max-h-56 [&_[data-slot=scroll-area-viewport]>div]:!block">
        {matching.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">Nobody matches “{search.trim()}”.</p>
        ) : (
          <ul className="flex flex-col p-1">
            {matching.map(candidate => {
              const checked = selected.has(candidate.userId)
              const fieldId = `${id}-${candidate.userId}`
              return (
                <li key={candidate.userId}>
                  <label
                    htmlFor={fieldId}
                    className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-60"
                  >
                    <Checkbox
                      id={fieldId}
                      checked={checked}
                      // Once the group is full, only taking someone out is possible.
                      disabled={disabled || (full && !checked)}
                      onCheckedChange={() => onToggle(candidate.userId)}
                    />
                    <UserAvatar username={candidate.username} presence={candidate.presence} className="size-7" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{candidate.username}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {presenceLine(candidate.kind === null ? undefined : KIND_LABELS[candidate.kind], candidate.presence, candidate.statusText)}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </ScrollArea>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {selected.size} chosen{full ? ' — that is as many as a group can hold' : ''}
      </p>
    </div>
  )
}
