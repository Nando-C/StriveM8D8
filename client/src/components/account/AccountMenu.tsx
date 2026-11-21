import { useState } from 'react'
import {
  ChevronsUpDown, HardDrive, KeyRound, LogOut, MessageSquareText, MonitorSmartphone, Trash2, UserPlus, UserRoundPlus,
} from 'lucide-react'
import {
  ChangePasswordDialog, CreateAccountDialog, DeleteAccountDialog, DevicesDialog, InvitationsDialog,
} from '@/components/account/AccountDialogs'
import { StatusDialog } from '@/components/account/StatusDialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { UserAvatar } from '@/components/UserAvatar'
import { formatBytes } from '@/lib/files'
import { ask } from '@/lib/request'
import type { ServerConfig } from '@/lib/serverConfig'
import { STATUS_CHOICES, STATUS_HINTS, STATUS_LABELS, type Presence } from '@/lib/status'
import type { Ack, IdentityKind, OwnStatus, SetStatusPayload, Status } from '@/types/protocol'

export interface AccountMenuProps {
  username: string
  /** `null` until the server has said (while signing back in). */
  kind: IdentityKind | null
  admin: boolean
  /** Whether this deployment stores files — an administrator is then shown how full storage is. */
  files?: boolean
  config: ServerConfig
  /** Requests need a logged-in connection: without one, only signing out is offered. */
  online: boolean
  /** What the user has chosen to show; `null` until the server has said. */
  ownStatus: OwnStatus | null
  onSetStatus: (payload: SetStatusPayload) => Promise<Ack<OwnStatus>>
  onBecameAccount: (session: string, admin: boolean) => void
  onLogout: () => void
  onDeleted: () => void
}

type Open = 'status' | 'create' | 'devices' | 'password' | 'invite' | 'delete' | null

const KIND_LABEL: Record<IdentityKind, string> = { guest: 'Guest', account: 'Account' }

/** The signed-in user's entry at the top of the sidebar, and everything they can do about themselves. */
export function AccountMenu({
  username, kind, admin, files = false, config, online, ownStatus, onSetStatus, onBecameAccount, onLogout, onDeleted,
}: AccountMenuProps) {
  const [open, setOpen] = useState<Open>(null)
  const close = () => setOpen(null)
  // How full storage is: asked for each time the menu opens, by whoever can act on it.
  const [usage, setUsage] = useState<string | null>(null)
  const showsUsage = admin && files
  const loadUsage = async () => {
    const answer = await ask('getStorageUsage', {})
    setUsage(answer.ok
      ? `${formatBytes(answer.usedBytes)} of ${formatBytes(answer.maxBytes)} used · ${answer.files} ${answer.files === 1 ? 'file' : 'files'}`
      : null)
  }
  const account = kind === 'account'
  // The user's own mark shows what they chose — which, invisible, is what others see: nothing.
  const ownPresence: Presence | undefined =
    ownStatus === null ? undefined : ownStatus.status === 'invisible' ? 'offline' : ownStatus.status

  return (
    <>
      <DropdownMenu onOpenChange={opened => opened && showsUsage && online && void loadUsage()}>
        <DropdownMenuTrigger
          aria-label={`Account menu for ${username}`}
          className="flex w-full items-center gap-3 rounded-lg p-2 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-sidebar-accent/60"
        >
          <UserAvatar username={username} presence={ownPresence} className="size-9" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted-foreground">Signed in as</span>
            <span className="block truncate font-medium">{username}</span>
            {ownStatus !== null && (ownStatus.status !== 'online' || ownStatus.statusText !== '') && (
              <span className="block truncate text-xs text-muted-foreground">
                {[ownStatus.status === 'online' ? null : STATUS_LABELS[ownStatus.status], ownStatus.statusText || null]
                  .filter(part => part !== null)
                  .join(' — ')}
              </span>
            )}
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>
            {kind === null ? username : `${username} · ${KIND_LABEL[kind]}${admin ? ' · Administrator' : ''}`}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {ownStatus !== null && (
            <>
              <DropdownMenuRadioGroup
                aria-label="Status"
                value={ownStatus.status}
                onValueChange={status => void onSetStatus({ status: status as Status })}
              >
                {STATUS_CHOICES.map(status => (
                  <DropdownMenuRadioItem key={status} value={status} disabled={!online} className="items-start">
                    <span className="flex flex-col">
                      {STATUS_LABELS[status]}
                      <span className="text-xs font-normal text-muted-foreground">{STATUS_HINTS[status]}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuItem disabled={!online} onSelect={() => setOpen('status')}>
                <MessageSquareText aria-hidden="true" />
                {ownStatus.statusText === '' ? 'Set a status message' : 'Change status message'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {kind === 'guest' && config.signup !== 'closed' && (
            <DropdownMenuItem disabled={!online} onSelect={() => setOpen('create')}>
              <UserRoundPlus aria-hidden="true" /> Create an account to keep this name
            </DropdownMenuItem>
          )}
          {account && (
            <>
              <DropdownMenuItem disabled={!online} onSelect={() => setOpen('devices')}>
                <MonitorSmartphone aria-hidden="true" /> Devices
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!online} onSelect={() => setOpen('password')}>
                <KeyRound aria-hidden="true" /> Change password
              </DropdownMenuItem>
              {admin && (
                <DropdownMenuItem disabled={!online} onSelect={() => setOpen('invite')}>
                  <UserPlus aria-hidden="true" /> Invite someone
                </DropdownMenuItem>
              )}
            </>
          )}
          {showsUsage && usage !== null && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              <HardDrive aria-hidden="true" className="mr-2 inline size-3.5" />
              Storage: {usage}
            </p>
          )}
          <DropdownMenuItem onSelect={onLogout}>
            <LogOut aria-hidden="true" /> {account ? 'Sign out' : 'Leave'}
          </DropdownMenuItem>
          {account && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={!online} onSelect={() => setOpen('delete')}>
                <Trash2 aria-hidden="true" /> Delete account
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {open === 'status' && (
        <StatusDialog current={ownStatus?.statusText ?? ''} onSetStatus={onSetStatus} onClose={close} />
      )}
      {open === 'create' && (
        <CreateAccountDialog
          username={username}
          needsInvitation={config.signup === 'invite'}
          onCreated={onBecameAccount}
          onClose={close}
        />
      )}
      {open === 'devices' && <DevicesDialog onClose={close} />}
      {open === 'password' && <ChangePasswordDialog username={username} onClose={close} />}
      {open === 'invite' && <InvitationsDialog onClose={close} />}
      {open === 'delete' && <DeleteAccountDialog username={username} onDeleted={onDeleted} onClose={close} />}
    </>
  )
}
