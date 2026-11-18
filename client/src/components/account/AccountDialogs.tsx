import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import { Field, FormError } from '@/components/account/fields'
import { RecoveryCode } from '@/components/account/RecoveryCode'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PASSWORD_HINT, isPassword, passwordInput } from '@/lib/credentials'
import { deviceLabel } from '@/lib/device'
import { invitationLink } from '@/lib/invitation'
import { ask } from '@/lib/request'
import type { DeviceSession, Invitation } from '@/types/protocol'

// The dialogs behind the account menu. Each one talks to the server itself and reports
// only its outcome, so the rest of the app never holds a password or a code.

interface DialogProps {
  onClose: () => void
}

interface ShellProps extends DialogProps {
  title: string
  description: ReactNode
  children: ReactNode
  /** While true the dialog cannot be dismissed: something shown in it would be lost. */
  locked?: boolean
}

function Shell({ title, description, children, locked = false, onClose }: ShellProps) {
  return (
    <Dialog open onOpenChange={open => !open && !locked && onClose()}>
      <DialogContent showCloseButton={!locked}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function Busy({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <>
      {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
      {children}
    </>
  )
}

const formatDate = (timestamp: number) =>
  new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

// ---------- a guest keeping their name

interface CreateAccountDialogProps extends DialogProps {
  username: string
  needsInvitation: boolean
  /** The guest is now an account, signed in on this device with `session`. */
  onCreated: (session: string, admin: boolean) => void
}

export function CreateAccountDialog({ username, needsInvitation, onCreated, onClose }: CreateAccountDialogProps) {
  const [password, setPassword] = useState('')
  const [invitation, setInvitation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    // Sent from the guest's own connection, which is all the proof the server needs.
    const answer = await ask('register', {
      username,
      password,
      deviceLabel: deviceLabel(),
      ...(needsInvitation ? { invitation: invitation.trim() } : {}),
    })
    setBusy(false)
    if (!answer.ok) {
      setError(answer.message)
      return
    }
    onCreated(answer.session, answer.admin)
    setRecoveryCode(answer.recoveryCode)
  }

  return (
    <Shell
      title="Create an account"
      description={`Keep the name “${username}” and your conversations, and sign in from any device with a password.`}
      locked={recoveryCode !== null}
      onClose={onClose}
    >
      {recoveryCode !== null ? (
        <RecoveryCode code={recoveryCode} onSaved={onClose} />
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {/* Not editable, but present so that a password manager saves the right pair. */}
          <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
          <Field
            id="upgrade-password"
            label="Password"
            hint={PASSWORD_HINT}
            autoFocus
            {...passwordInput('new-password')}
            value={password}
            onChange={event => setPassword(event.target.value)}
            disabled={busy}
          />
          {needsInvitation && (
            <Field
              id="upgrade-invitation"
              label="Invitation code"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={100}
              value={invitation}
              onChange={event => setInvitation(event.target.value)}
              disabled={busy}
            />
          )}
          <FormError message={error} />
          <Button type="submit" disabled={busy || !isPassword(password) || (needsInvitation && invitation.trim() === '')}>
            <Busy busy={busy}>Create account</Busy>
          </Button>
        </form>
      )}
    </Shell>
  )
}

// ---------- devices

export function DevicesDialog({ onClose }: DialogProps) {
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  // Bumped to ask the server for the list again.
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let current = true
    void ask('listSessions', {}).then(answer => {
      if (!current) return
      if (answer.ok) setSessions(answer.sessions)
      else setError(answer.message)
      setRevoking(null)
    })
    return () => {
      current = false
    }
  }, [version])

  const revoke = async (id: string) => {
    setRevoking(id)
    setError(null)
    const answer = await ask('revokeSession', { id })
    if (!answer.ok) setError(answer.message)
    setVersion(count => count + 1)
  }

  return (
    <Shell
      title="Devices"
      description="Where your account is signed in. Signing a device out disconnects it at once."
      onClose={onClose}
    >
      {sessions === null && error === null && (
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading…
        </p>
      )}
      {sessions !== null && (
        <ul aria-label="Signed-in devices" className="flex flex-col divide-y">
          {sessions.map(session => (
            <li key={session.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  <span className="truncate">{session.label === '' ? 'Unnamed device' : session.label}</span>
                  {session.current && <Badge variant="secondary">This device</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  Signed in {formatDate(session.createdAt)} · last used {formatDate(session.lastUsedAt)}
                </p>
              </div>
              {!session.current && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoking !== null}
                  onClick={() => void revoke(session.id)}
                >
                  <Busy busy={revoking === session.id}>Sign out</Busy>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormError message={error} />
    </Shell>
  )
}

// ---------- password

export function ChangePasswordDialog({ username, onClose }: DialogProps & { username: string }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const answer = await ask('changePassword', { currentPassword, newPassword })
    setBusy(false)
    if (answer.ok) setDone(true)
    else setError(answer.message)
  }

  return (
    <Shell
      title="Change password"
      description="Your other devices will be signed out. This one stays signed in."
      onClose={onClose}
    >
      {done ? (
        <div className="flex flex-col gap-4">
          <p role="status">Your password was changed, and your other devices were signed out.</p>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
          <Field
            id="current-password"
            label="Current password"
            autoFocus
            {...passwordInput('current-password')}
            value={currentPassword}
            onChange={event => setCurrentPassword(event.target.value)}
            disabled={busy}
          />
          <Field
            id="new-password"
            label="New password"
            hint={PASSWORD_HINT}
            {...passwordInput('new-password')}
            value={newPassword}
            onChange={event => setNewPassword(event.target.value)}
            disabled={busy}
          />
          <FormError message={error} />
          <Button type="submit" disabled={busy || currentPassword === '' || !isPassword(newPassword)}>
            <Busy busy={busy}>Change password</Busy>
          </Button>
        </form>
      )}
    </Shell>
  )
}

// ---------- invitations (administrators)

export function InvitationsDialog({ onClose }: DialogProps) {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [version, setVersion] = useState(0)
  useEffect(() => {
    let current = true
    void ask('listInvitations', {}).then(answer => {
      if (!current) return
      if (answer.ok) setInvitations(answer.invitations)
      else setError(answer.message)
      setBusy(false)
    })
    return () => {
      current = false
    }
  }, [version])

  const create = async () => {
    setBusy(true)
    setError(null)
    setCopied(false)
    const answer = await ask('createInvitation', {})
    if (answer.ok) setLink(invitationLink(answer.code))
    else setError(answer.message)
    setVersion(count => count + 1)
  }

  const revoke = async (id: string) => {
    setBusy(true)
    setError(null)
    const answer = await ask('revokeInvitation', { id })
    if (!answer.ok) setError(answer.message)
    setVersion(count => count + 1)
  }

  const copy = async () => {
    if (link === null) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Shell
      title="Invite someone"
      description="Each link lets one person create an account, and works for 7 days. Send it any way you like."
      onClose={onClose}
    >
      {link !== null && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Copy this link now — it cannot be shown again, only revoked.
          </p>
          <output
            aria-label="Invitation link"
            className="rounded-lg border bg-muted px-3 py-2 font-mono text-xs break-all select-all"
          >
            {link}
          </output>
          <Button variant="outline" onClick={() => void copy()}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      )}
      <Button onClick={() => void create()} disabled={busy}>
        <Busy busy={busy}>{link === null ? 'Create an invitation link' : 'Create another'}</Busy>
      </Button>
      {invitations !== null && invitations.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Not used yet</h3>
          <ul aria-label="Unused invitations" className="flex flex-col divide-y">
            {invitations.map(invitation => (
              <li key={invitation.id} className="flex items-center gap-3 py-2">
                <p className="min-w-0 flex-1">
                  Created {formatDate(invitation.createdAt)}
                  <span className="block text-xs text-muted-foreground">Expires {formatDate(invitation.expiresAt)}</span>
                </p>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void revoke(invitation.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <FormError message={error} />
    </Shell>
  )
}

// ---------- deleting the account

interface DeleteAccountDialogProps extends DialogProps {
  username: string
  /** The account no longer exists. */
  onDeleted: () => void
}

export function DeleteAccountDialog({ username, onDeleted, onClose }: DeleteAccountDialogProps) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const answer = await ask('deleteAccount', { password })
    setBusy(false)
    if (answer.ok) onDeleted()
    else setError(answer.message)
  }

  return (
    <Shell
      title="Delete account"
      description={`This removes “${username}” and signs out every device. It cannot be undone, and the name becomes free for someone else to take.`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
        <Field
          id="delete-password"
          label="Password"
          hint="Enter your password to confirm."
          autoFocus
          {...passwordInput('current-password')}
          value={password}
          onChange={event => setPassword(event.target.value)}
          disabled={busy}
        />
        <FormError message={error} />
        <Button type="submit" variant="destructive" disabled={busy || password === ''}>
          <Busy busy={busy}>Delete my account</Busy>
        </Button>
      </form>
    </Shell>
  )
}
