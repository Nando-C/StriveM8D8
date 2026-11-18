import { useState, type FormEvent, type ReactNode } from 'react'
import { LoaderCircle, MessagesSquare } from 'lucide-react'
import { Field, FormError } from '@/components/account/fields'
import { RecoveryCode } from '@/components/account/RecoveryCode'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PASSWORD_HINT, USERNAME_HINT, isPassword, passwordInput, usernameInput } from '@/lib/credentials'
import { deviceLabel } from '@/lib/device'
import { bootstrapFromLink, dropCodesFromLink, invitationFromLink } from '@/lib/invitation'
import { ask } from '@/lib/request'
import type { ServerConfig } from '@/lib/serverConfig'
import { loadReservation } from '@/lib/session'
import { WAKING_HINT, WAKING_NOTICE_DELAY_MS, useDelayed } from '@/lib/waking'

type Way = 'guest' | 'signin' | 'create'

interface EntryScreenProps {
  config: ServerConfig
  connected: boolean
  /** A login request is waiting for the server's answer. */
  pending: boolean
  /** Why the last login was refused, or why this device was signed out. */
  error: string | null
  onGuest: (username: string) => void
  onSignIn: (username: string, password: string) => void
  /** An account was just created here: log in with its device session. */
  onAccountCreated: (username: string, session: string) => void
}

interface SubmitProps {
  connected: boolean
  busy: boolean
  disabled: boolean
  children: ReactNode
}

function Submit({ connected, busy, disabled, children }: SubmitProps) {
  return (
    <Button type="submit" size="lg" disabled={busy || disabled}>
      {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
      {!busy ? children : connected ? 'Signing in…' : 'Connecting…'}
    </Button>
  )
}

export function EntryScreen({ config, connected, pending, error, onGuest, onSignIn, onAccountCreated }: EntryScreenProps) {
  const invitation = invitationFromLink()
  const bootstrapCode = bootstrapFromLink()
  const ways: Way[] = [
    ...(config.guests ? (['guest'] as const) : []),
    'signin',
    ...(config.signup !== 'closed' ? (['create'] as const) : []),
  ]
  // Someone who followed an invitation link came to create an account.
  const [chosen, setChosen] = useState<Way>(invitation !== '' || bootstrapCode !== '' ? 'create' : 'guest')
  // What the server offers can arrive (or change) after the first render.
  const way = ways.includes(chosen) ? chosen : ways[0]
  // An error belongs to the way in that caused it: it is hidden once another is chosen.
  const [errorHidden, setErrorHidden] = useState<string | null>(null)
  // A new account's recovery code, shown before going any further.
  const [created, setCreated] = useState<{ username: string; session: string; recoveryCode: string } | null>(null)
  // Only while the very first connection is slow: the server is probably waking up.
  const waking = useDelayed(!connected, WAKING_NOTICE_DELAY_MS)

  const choose = (next: string) => {
    setChosen(next as Way)
    setErrorHidden(error)
  }
  const shownError = error !== null && error !== errorHidden ? error : null
  const submitted = () => setErrorHidden(null)

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <MessagesSquare aria-hidden="true" className="size-5" />
          </div>
          <CardTitle>
            <h1>Strive Chat</h1>
          </CardTitle>
          <CardDescription>
            {config.guests
              ? 'Pick a name and start a one-to-one conversation with anyone online.'
              : 'Sign in to talk to the people here.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {created !== null ? (
            <RecoveryCode
              code={created.recoveryCode}
              onSaved={() => {
                onAccountCreated(created.username, created.session)
                setCreated(null)
              }}
            />
          ) : (
            <>
              {waking && (
                <Alert role="status">
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                  <AlertDescription>
                    <span className="font-medium text-foreground">Waking the server…</span> {WAKING_HINT} You can
                    enter your name now; you will be signed in as soon as it is up.
                  </AlertDescription>
                </Alert>
              )}
              <Tabs value={way} onValueChange={choose}>
                {ways.length > 1 && (
                  <TabsList className="w-full">
                    {ways.includes('guest') && <TabsTrigger value="guest">Guest</TabsTrigger>}
                    <TabsTrigger value="signin">Sign in</TabsTrigger>
                    {ways.includes('create') && <TabsTrigger value="create">Create account</TabsTrigger>}
                  </TabsList>
                )}
                <TabsContent value="guest">
                  <GuestForm connected={connected} pending={pending} error={shownError} onGuest={onGuest} onSubmitted={submitted} />
                </TabsContent>
                <TabsContent value="signin">
                  <SignInForm connected={connected} pending={pending} error={shownError} onSignIn={onSignIn} onSubmitted={submitted} />
                </TabsContent>
                <TabsContent value="create">
                  <CreateAccountForm
                    connected={connected}
                    // The owner's code stands in for an invitation.
                    needsInvitation={config.signup === 'invite' && bootstrapCode === ''}
                    invitation={invitation}
                    bootstrapCode={bootstrapCode}
                    onCreated={account => {
                      dropCodesFromLink()
                      setCreated(account)
                    }}
                  />
                </TabsContent>
              </Tabs>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

interface LoginFormProps {
  connected: boolean
  pending: boolean
  error: string | null
  onSubmitted: () => void
}

function GuestForm({ connected, pending, error, onGuest, onSubmitted }: LoginFormProps & { onGuest: (username: string) => void }) {
  const [username, setUsername] = useState('')
  const trimmed = username.trim()

  // The form works before the connection is up; the request is sent once it is.
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (pending || trimmed === '') return
    onSubmitted()
    onGuest(trimmed)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field
        id="username"
        label="Username"
        hint={`${USERNAME_HINT} No password: the name is kept for you in this browser.`}
        autoComplete="off"
        autoFocus
        {...usernameInput}
        value={username}
        onChange={event => setUsername(event.target.value)}
        disabled={pending}
        aria-invalid={error !== null}
      />
      <FormError message={error} />
      <Submit connected={connected} busy={pending} disabled={trimmed === ''}>
        Join
      </Submit>
    </form>
  )
}

function SignInForm({ connected, pending, error, onSignIn, onSubmitted }: LoginFormProps & { onSignIn: (username: string, password: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [recovering, setRecovering] = useState(false)
  const trimmed = username.trim()

  if (recovering) {
    return (
      <RecoverForm
        connected={connected}
        username={username}
        onUsernameChange={setUsername}
        onBack={() => setRecovering(false)}
        onRecovered={newPassword => {
          setRecovering(false)
          onSubmitted()
          onSignIn(trimmed, newPassword)
        }}
      />
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (pending || trimmed === '' || password === '') return
    onSubmitted()
    onSignIn(trimmed, password)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field
        id="signin-username"
        label="Username"
        autoComplete="username"
        autoFocus
        {...usernameInput}
        value={username}
        onChange={event => setUsername(event.target.value)}
        disabled={pending}
      />
      <Field
        id="signin-password"
        label="Password"
        {...passwordInput('current-password')}
        value={password}
        onChange={event => setPassword(event.target.value)}
        disabled={pending}
        aria-invalid={error !== null}
      />
      <FormError message={error} />
      <Submit connected={connected} busy={pending} disabled={trimmed === '' || password === ''}>
        Sign in
      </Submit>
      <Button type="button" variant="link" size="sm" className="self-center" onClick={() => setRecovering(true)}>
        Forgot your password?
      </Button>
    </form>
  )
}

interface RecoverFormProps {
  connected: boolean
  username: string
  onUsernameChange: (username: string) => void
  onBack: () => void
  /** The password was replaced, and the reader has kept the new recovery code. */
  onRecovered: (newPassword: string) => void
}

function RecoverForm({ connected, username, onUsernameChange, onBack, onRecovered }: RecoverFormProps) {
  const [recoveryCode, setRecoveryCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [replacement, setReplacement] = useState<string | null>(null)
  const trimmed = username.trim()

  if (replacement !== null) {
    return <RecoveryCode code={replacement} onSaved={() => onRecovered(newPassword)} />
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const answer = await ask('resetPassword', { username: trimmed, recoveryCode, newPassword })
    setBusy(false)
    if (answer.ok) setReplacement(answer.recoveryCode)
    else setError(answer.message)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-muted-foreground">
        Enter the recovery code you were given when you created the account, and choose a new password. Every
        device will be signed out.
      </p>
      <Field
        id="recover-username"
        label="Username"
        autoComplete="username"
        {...usernameInput}
        value={username}
        onChange={event => onUsernameChange(event.target.value)}
        disabled={busy}
      />
      <Field
        id="recover-code"
        label="Recovery code"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={40}
        value={recoveryCode}
        onChange={event => setRecoveryCode(event.target.value)}
        disabled={busy}
      />
      <Field
        id="recover-password"
        label="New password"
        hint={PASSWORD_HINT}
        {...passwordInput('new-password')}
        value={newPassword}
        onChange={event => setNewPassword(event.target.value)}
        disabled={busy}
      />
      <FormError message={error} />
      <Button
        type="submit"
        size="lg"
        disabled={busy || !connected || trimmed === '' || recoveryCode.trim() === '' || !isPassword(newPassword)}
      >
        {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
        {connected ? 'Set new password' : 'Connecting…'}
      </Button>
      <Button type="button" variant="link" size="sm" className="self-center" onClick={onBack} disabled={busy}>
        Back to sign in
      </Button>
    </form>
  )
}

interface CreateAccountFormProps {
  connected: boolean
  needsInvitation: boolean
  /** From an invitation link, if that is how the reader got here. */
  invitation: string
  /** From the deployment owner's link; '' for everyone else. */
  bootstrapCode: string
  onCreated: (account: { username: string; session: string; recoveryCode: string }) => void
}

function CreateAccountForm({ connected, needsInvitation, invitation: linked, bootstrapCode, onCreated }: CreateAccountFormProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [invitation, setInvitation] = useState(linked)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = username.trim()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    // A name this browser already holds as a guest becomes the account, conversations and all.
    const reservation = loadReservation(trimmed)
    const answer = await ask('register', {
      username: trimmed,
      password,
      deviceLabel: deviceLabel(),
      ...(reservation === undefined ? {} : { reservation }),
      ...(needsInvitation ? { invitation: invitation.trim() } : {}),
      ...(bootstrapCode === '' ? {} : { bootstrapCode }),
    })
    setBusy(false)
    if (answer.ok) onCreated({ username: trimmed, session: answer.session, recoveryCode: answer.recoveryCode })
    else setError(answer.message)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field
        id="create-username"
        label="Username"
        hint={USERNAME_HINT}
        autoComplete="username"
        autoFocus
        {...usernameInput}
        value={username}
        onChange={event => setUsername(event.target.value)}
        disabled={busy}
      />
      <Field
        id="create-password"
        label="Password"
        hint={PASSWORD_HINT}
        {...passwordInput('new-password')}
        value={password}
        onChange={event => setPassword(event.target.value)}
        disabled={busy}
      />
      {bootstrapCode !== '' && (
        <p className="text-xs text-muted-foreground">
          You are using this deployment’s owner link: it registers an administrator name.
        </p>
      )}
      {needsInvitation && (
        <Field
          id="create-invitation"
          label="Invitation code"
          hint="Sign-up here is by invitation. The code is the last part of the link you were sent."
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
      <Button
        type="submit"
        size="lg"
        disabled={busy || !connected || trimmed === '' || !isPassword(password) || (needsInvitation && invitation.trim() === '')}
      >
        {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
        {connected ? 'Create account' : 'Connecting…'}
      </Button>
    </form>
  )
}
