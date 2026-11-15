import { CopyX, LoaderCircle, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Phase } from '@/lib/chatState'

interface ConnectionBannerProps {
  connected: boolean
  phase: Phase
  username: string
  onReconnect: () => void
}

const BAR = 'flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2 text-sm'

/** Explains why the chat is not live right now. Renders nothing when everything is fine. */
export function ConnectionBanner({ connected, phase, username, onReconnect }: ConnectionBannerProps) {
  if (phase === 'replaced') {
    return (
      <div role="alert" className={`${BAR} bg-muted`}>
        <CopyX aria-hidden="true" className="size-4 shrink-0" />
        <p className="min-w-0 flex-1">
          <span className="font-medium">Signed in from another tab.</span> {username} is now active there. Close
          that tab, then reconnect here.
        </p>
        <Button size="sm" variant="outline" onClick={onReconnect}>
          Reconnect here
        </Button>
      </div>
    )
  }

  if (!connected) {
    return (
      <div role="status" className={`${BAR} bg-destructive/10 text-destructive`}>
        <WifiOff aria-hidden="true" className="size-4 shrink-0" />
        <p className="min-w-0 flex-1">
          <span className="font-medium">Disconnected.</span> Trying to reconnect — messages cannot be sent until
          the connection is back.
        </p>
      </div>
    )
  }

  if (phase === 'authenticating') {
    return (
      <div role="status" className={`${BAR} bg-muted text-muted-foreground`}>
        <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
        <p>Signing back in as {username}…</p>
      </div>
    )
  }

  return null
}
