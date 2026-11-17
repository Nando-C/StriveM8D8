import { AnimatePresence, motion } from 'motion/react'
import { CopyX, LoaderCircle, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Phase } from '@/lib/chatState'
import { notice } from '@/lib/motion'
import { WAKING_HINT } from '@/lib/waking'
import { cn } from '@/lib/utils'

interface ConnectionBannerProps {
  connected: boolean
  /** Whether a connection has ever been established in this page's lifetime. */
  everConnected: boolean
  phase: Phase
  username: string
  onReconnect: () => void
}

type Kind = 'replaced' | 'waking' | 'disconnected' | 'authenticating' | null

/**
 * Explains why the chat is not live right now; renders nothing when everything is fine.
 *
 * It floats over the bottom of the screen instead of sitting in the layout, so it can
 * slide in and out without pushing — and re-laying-out — everything else.
 */
export function ConnectionBanner({ connected, everConnected, phase, username, onReconnect }: ConnectionBannerProps) {
  const kind: Kind =
    phase === 'replaced'
      ? 'replaced'
      : !connected
        ? everConnected
          ? 'disconnected'
          : 'waking'
        : phase === 'authenticating'
          ? 'authenticating'
          : null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-20 flex justify-center px-3">
      <AnimatePresence mode="wait">
        {kind !== null && (
          <motion.div
            key={kind}
            variants={notice}
            initial="hidden"
            animate="visible"
            exit="exit"
            role={kind === 'replaced' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-2.5 text-sm shadow-lg',
              kind === 'disconnected'
                ? 'border-destructive/30 bg-background text-destructive'
                : 'bg-background text-foreground',
            )}
          >
            {kind === 'replaced' && (
              <>
                <CopyX aria-hidden="true" className="size-4 shrink-0" />
                <p className="min-w-0 flex-1">
                  <span className="font-medium">Signed in from another tab.</span> {username} is now active there.
                  Close that tab, then reconnect here.
                </p>
                <Button size="sm" variant="outline" onClick={onReconnect}>
                  Reconnect here
                </Button>
              </>
            )}
            {kind === 'disconnected' && (
              <>
                <WifiOff aria-hidden="true" className="size-4 shrink-0" />
                <p className="min-w-0 flex-1">
                  <span className="font-medium">Disconnected.</span> Trying to reconnect — messages cannot be sent
                  until the connection is back.
                </p>
              </>
            )}
            {kind === 'waking' && (
              <>
                <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
                <p className="min-w-0 flex-1">
                  <span className="font-medium">Connecting to the server…</span> {WAKING_HINT}
                </p>
              </>
            )}
            {kind === 'authenticating' && (
              <>
                <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
                <p>Signing back in as {username}…</p>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
