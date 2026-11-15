import { useState, type FormEvent } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface LoginFormProps {
  connected: boolean
  /** A login request is waiting for the server's answer. */
  pending: boolean
  error: string | null
  onLogin: (username: string) => void
}

export function LoginForm({ connected, pending, error, onLogin }: LoginFormProps) {
  const [username, setUsername] = useState('')
  const disabled = !connected || pending
  const trimmed = username.trim()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (disabled || trimmed === '') return
    onLogin(trimmed)
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Strive Chat</CardTitle>
          <CardDescription>Pick a username to start chatting.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                name="username"
                autoComplete="off"
                autoFocus
                maxLength={30}
                value={username}
                onChange={event => setUsername(event.target.value)}
                disabled={disabled}
                aria-invalid={error !== null}
                aria-describedby="username-hint"
              />
              <p id="username-hint" className="text-xs text-muted-foreground">
                Up to 30 letters, digits, hyphens or underscores.
              </p>
            </div>
            {error !== null && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={disabled || trimmed === ''}>
              {!connected ? 'Connecting…' : pending ? 'Signing in…' : 'Join'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
