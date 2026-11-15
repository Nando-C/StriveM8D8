import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { Phase } from '@/lib/chatState'

interface ConnectionBannerProps {
  connected: boolean
  phase: Phase
  username: string
  onReconnect: () => void
}

/** Explains why the chat is not live right now. Renders nothing when everything is fine. */
export function ConnectionBanner({ connected, phase, username, onReconnect }: ConnectionBannerProps) {
  if (phase === 'replaced') {
    return (
      <Alert className="rounded-none border-x-0 border-t-0">
        <AlertTitle>Signed in from another tab</AlertTitle>
        <AlertDescription>
          {username} is now active in another tab. Close that tab, then reconnect here.
        </AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={onReconnect}>
            Reconnect here
          </Button>
        </AlertAction>
      </Alert>
    )
  }

  if (!connected) {
    return (
      <Alert role="status" className="rounded-none border-x-0 border-t-0">
        <AlertTitle>Disconnected</AlertTitle>
        <AlertDescription>Trying to reconnect. Messages cannot be sent until the connection is back.</AlertDescription>
      </Alert>
    )
  }

  if (phase === 'authenticating') {
    return (
      <Alert role="status" className="rounded-none border-x-0 border-t-0">
        <AlertDescription>Signing back in as {username}…</AlertDescription>
      </Alert>
    )
  }

  return null
}
