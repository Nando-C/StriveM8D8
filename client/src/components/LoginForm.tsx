import { useState, type FormEvent } from 'react'
import { LoaderCircle, MessagesSquare } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { WAKING_HINT, WAKING_NOTICE_DELAY_MS, useDelayed } from '@/lib/waking'

interface LoginFormProps {
  connected: boolean
  /** A login request is waiting for the server's answer. */
  pending: boolean
  error: string | null
  onLogin: (username: string) => void
}

export function LoginForm({ connected, pending, error, onLogin }: LoginFormProps) {
  const [username, setUsername] = useState('')
  // The form works before the connection is up; the request is sent once it is.
  const busy = pending
  const trimmed = username.trim()
  // Only while the very first connection is slow: the server is probably waking up.
  const waking = useDelayed(!connected, WAKING_NOTICE_DELAY_MS)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || trimmed === '') return
    onLogin(trimmed)
  }

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
          <CardDescription>Pick a name and start a one-to-one conversation with anyone online.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                name="username"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                maxLength={30}
                value={username}
                onChange={event => setUsername(event.target.value)}
                disabled={pending}
                aria-invalid={error !== null}
                aria-describedby="username-hint"
              />
              <p id="username-hint" className="text-xs text-muted-foreground">
                Up to 30 letters, digits, hyphens or underscores. No password — this is a demo.
              </p>
            </div>
            {waking && (
              <Alert role="status">
                <LoaderCircle aria-hidden="true" className="animate-spin" />
                <AlertDescription>
                  <span className="font-medium text-foreground">Waking the server…</span> {WAKING_HINT} You can
                  enter your name now; you will be signed in as soon as it is up.
                </AlertDescription>
              </Alert>
            )}
            {error !== null && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" size="lg" disabled={busy || trimmed === ''}>
              {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              {!pending ? 'Join' : connected ? 'Signing in…' : 'Connecting…'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
