import { useState, type FormEvent } from 'react'
import { LogOut, UserMinus, UserPlus } from 'lucide-react'
import { Busy, Field, FormError } from '@/components/account/fields'
import { PeoplePicker } from '@/components/groups/PeoplePicker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { UserAvatar } from '@/components/UserAvatar'
import type { Candidate, OpenGroup } from '@/lib/chatSelectors'
import { MAX_GROUP_MEMBERS, MAX_GROUP_NAME_LENGTH } from '@/lib/groupEvents'
import { ask } from '@/lib/request'
import { oneLine } from '@/lib/messages'
import { presenceLineOf } from '@/lib/status'
import { SCROLL_AREA_ROWS, cn } from '@/lib/utils'
import { useChosen } from '@/lib/useChosen'
import { useRequest } from '@/lib/useRequest'

interface GroupDetailsProps {
  conversationId: string
  group: OpenGroup
  /** Everyone who could be added (those already in are left out here). */
  candidates: Candidate[]
  /** Requests need a logged-in connection. */
  online: boolean
  onClose: () => void
}

type View = 'details' | 'add' | 'leave'

/**
 * Who is in a group, and what can be done about it: anyone can add people and leave; the
 * admin can also rename it and remove someone. Every change is made by the server and
 * comes back as the group's new state — nothing here is changed in advance.
 */
export function GroupDetails({ conversationId, group, candidates, online, onClose }: GroupDetailsProps) {
  const [view, setView] = useState<View>('details')
  // What the admin has typed, if anything: until then the field shows the name as it is
  // now, including a change made meanwhile from elsewhere.
  const [draft, setDraft] = useState<string | null>(null)
  const name = draft ?? group.name
  const { busy, error, run } = useRequest()

  const admin = group.members.find(member => member.admin)
  const memberIds = new Set(group.members.map(member => member.userId))
  const addable = candidates.filter(candidate => !memberIds.has(candidate.userId))
  const { chosen, toggle, clear } = useChosen(addable)
  const room = MAX_GROUP_MEMBERS - group.members.length
  // (As the server will store it.)
  const newName = oneLine(name)
  const renamable = newName !== '' && newName !== group.name
  const blocked = busy || !online

  const rename = (event: FormEvent) => {
    event.preventDefault()
    if (!renamable) return
    void run(() => ask('renameGroup', { conversationId, name: newName }), () => setDraft(null))
  }
  const remove = (userId: string) => void run(() => ask('removeMember', { conversationId, userId }), () => {})
  const add = () =>
    void run(() => ask('addMembers', { conversationId, userIds: [...chosen] }), () => {
      clear()
      setView('details')
    })
  // (The conversation closes by itself when the server says the user is out of it.)
  const leave = () => void run(() => ask('leaveGroup', { conversationId }), () => onClose())

  return (
    <Sheet open onOpenChange={open => !open && onClose()}>
      <SheetContent className="gap-0">
        <SheetHeader>
          <SheetTitle>{group.name}</SheetTitle>
          <SheetDescription>
            {group.members.length} {group.members.length === 1 ? 'member' : 'members'}
            {group.isAdmin ? ' · You are the admin' : admin === undefined ? '' : ` · ${admin.username} is the admin`}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className={cn('min-h-0 flex-1', SCROLL_AREA_ROWS)}>
          <div className="flex flex-col gap-5 px-4 pb-4">
            {!online && <p className="text-sm text-muted-foreground">Changes can be made again once you are connected.</p>}
            <FormError message={error} />

            {view === 'leave' ? (
              <section aria-label="Leave group" className="flex flex-col gap-3">
                <p>
                  Leave “{group.name}”? You will no longer see it or its messages
                  {group.isAdmin && group.members.length > 1 ? ', and whoever has been in it longest becomes its admin' : ''}.
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => setView('details')} disabled={busy}>
                    Cancel
                  </Button>
                  <Button variant="destructive" className="flex-1" onClick={leave} disabled={blocked}>
                    <Busy busy={busy}>Leave group</Busy>
                  </Button>
                </div>
              </section>
            ) : view === 'add' ? (
              <section aria-label="Add people" className="flex flex-col gap-3">
                <PeoplePicker id="add-people" candidates={addable} selected={chosen} onToggle={toggle} max={room} disabled={busy} />
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => setView('details')} disabled={busy}>
                    Back
                  </Button>
                  <Button className="flex-1" onClick={add} disabled={blocked || chosen.size === 0}>
                    <Busy busy={busy}>Add to group</Busy>
                  </Button>
                </div>
              </section>
            ) : (
              <>
                {group.isAdmin && (
                  <form onSubmit={rename} className="flex items-end gap-2" noValidate>
                    <div className="min-w-0 flex-1">
                      <Field
                        id="group-rename"
                        label="Group name"
                        autoComplete="off"
                        maxLength={MAX_GROUP_NAME_LENGTH}
                        value={name}
                        onChange={event => setDraft(event.target.value)}
                        disabled={busy}
                      />
                    </div>
                    <Button type="submit" variant="outline" disabled={blocked || !renamable}>
                      Rename
                    </Button>
                  </form>
                )}
                <section aria-label="Members" className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Members</h3>
                  <ul className="flex flex-col gap-1">
                    {group.members.map(member => (
                      <li key={member.userId} className="flex items-center gap-3 py-1">
                        <UserAvatar username={member.username} presence={member.own ? undefined : member.presence} className="size-8" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex items-center gap-2">
                            <span className="truncate">{member.username}</span>
                            {member.own && <span className="text-xs text-muted-foreground">You</span>}
                            {member.admin && <Badge variant="secondary">Admin</Badge>}
                          </span>
                          {!member.own && (
                            <span className="truncate text-xs text-muted-foreground">
                              {presenceLineOf(member)}
                            </span>
                          )}
                        </span>
                        {group.isAdmin && !member.own && (
                          <Button variant="ghost" size="icon-sm" onClick={() => remove(member.userId)} disabled={blocked}>
                            <UserMinus aria-hidden="true" />
                            <span className="sr-only">Remove {member.username}</span>
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
                <div className="flex flex-col gap-2">
                  {room > 0 && (
                    <Button variant="outline" onClick={() => setView('add')} disabled={blocked}>
                      <UserPlus aria-hidden="true" />
                      Add people
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setView('leave')} disabled={blocked}>
                    <LogOut aria-hidden="true" />
                    Leave group
                  </Button>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
