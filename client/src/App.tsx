import { Button } from '@/components/ui/button'
import { useSocketConnected } from '@/lib/useSocketConnected'

// Scaffold shell: proves the build, the "@/" alias, Tailwind, shadcn/ui and the socket
// connection all work together. The chat UI replaces it.
function App() {
  const connected = useSocketConnected()

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4">
      <Button>Strive Chat</Button>
      <p role="status" className="text-sm text-muted-foreground">
        {connected ? 'connected' : 'connecting…'}
      </p>
    </main>
  )
}

export default App
