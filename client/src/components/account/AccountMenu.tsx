import { useState } from 'react'
import { ChevronsUpDown, KeyRound, LogOut, MonitorSmartphone, Trash2, UserPlus, UserRoundPlus } from 'lucide-react'
import {
  ChangePasswordDialog, CreateAccountDialog, DeleteAccountDialog, DevicesDialog, InvitationsDialog,
} from '@/components/account/AccountDialogs'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { UserAvatar } from '@/components/UserAvatar'
import type { ServerConfig } from '@/lib/serverConfig'
import type { IdentityKind } from '@/types/protocol'

export interface AccountMenuProps {
  username: string
  /** `null` until the server has said (while signing back in). */
  kind: IdentityKind | null
  admin: boolean
  config: ServerConfig
  /** Requests need a logged-in connection: without one, only signing out is offered. */
  online: boolean
  onBecameAccount: (session: string, admin: boolean) => void
  onLogout: () => void
  onDeleted: () => void
}

type Open = 'create' | 'devices' | 'password' | 'invite' | 'delete' | null

const KIND_LABEL: Record<IdentityKind, string> = { guest: 'Guest', account: 'Account' }

/** The signed-in user's entry at the top of the sidebar, and everything they can do about themselves. */
export function AccountMenu({ username, kind, admin, config, online, onBecameAccount, onLogout, onDeleted }: AccountMenuProps) {
  const [open, setOpen] = useState<Open>(null)
  const close = () => setOpen(null)
  const account = kind === 'account'

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Account menu for ${username}`}
          className="flex w-full items-center gap-3 rounded-lg p-2 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-sidebar-accent/60"
        >
          <UserAvatar username={username} className="size-9" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted-foreground">Signed in as</span>
            <span className="block truncate font-medium">{username}</span>
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>
            {kind === null ? username : `${username} · ${KIND_LABEL[kind]}${admin ? ' · Administrator' : ''}`}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
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
