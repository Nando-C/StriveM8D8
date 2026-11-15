import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, MessagesSquare } from 'lucide-react'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import { LoginForm } from '@/components/LoginForm'
import { MessageComposer } from '@/components/MessageComposer'
import { MessageList } from '@/components/MessageList'
import { Sidebar } from '@/components/Sidebar'
import { Button } from '@/components/ui/button'
import { UserAvatar } from '@/components/UserAvatar'
import { useChat } from '@/hooks/useChat'
import { fade } from '@/lib/motion'
import { cn } from '@/lib/utils'

function App() {
  const chat = useChat()

  // The login form and the chat cross-fade into each other.
  return (
    <AnimatePresence mode="wait" initial={false}>
      {chat.username === null ? (
        // No identity yet (or the last login was refused): the login form is the whole screen.
        <motion.div key="login" variants={fade} initial="hidden" animate="visible" exit="exit">
          <LoginForm
            connected={chat.connected}
            pending={chat.phase === 'authenticating'}
            error={chat.loginError}
            onLogin={chat.login}
          />
        </motion.div>
      ) : (
        <motion.div key="chat" variants={fade} initial="hidden" animate="visible" exit="exit">
          <ChatShell chat={chat} username={chat.username} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ChatShell({ chat, username }: { chat: ReturnType<typeof useChat>; username: string }) {

  const blockedReason = !chat.connected
    ? 'Disconnected'
    : chat.phase !== 'loggedIn'
      ? 'Signing in…'
      : !chat.selectedOnline
        ? `${chat.selected} is offline`
        : null

  // Announce messages that arrive in a conversation that is not on screen; the open
  // conversation announces its own through the message list.
  const offscreen = chat.lastIncoming !== null && chat.lastIncoming.from !== chat.selected ? chat.lastIncoming : null

  return (
    <div className="flex h-svh flex-col">
      <ConnectionBanner
        connected={chat.connected}
        everConnected={chat.everConnected}
        phase={chat.phase}
        username={username}
        onReconnect={chat.reconnect}
      />
      <p role="status" aria-live="polite" className="sr-only">
        {offscreen !== null && <span key={offscreen.id}>New message from {offscreen.from}</span>}
      </p>
      <div className="flex min-h-0 flex-1">
        {/* On a phone the list and the conversation are separate views; from md up they sit side by side. */}
        <Sidebar
          username={username}
          users={chat.users}
          selected={chat.selected}
          selectedOnline={chat.selectedOnline}
          conversations={chat.conversations}
          onSelect={chat.selectConversation}
          className={cn('w-full md:w-72 md:shrink-0', chat.selected !== null && 'hidden md:flex')}
        />
        <main className={cn('min-w-0 flex-1 flex-col', chat.selected === null ? 'hidden md:flex' : 'flex')}>
          {chat.selected === null ? (
            <motion.div
              variants={fade}
              initial="hidden"
              animate="visible"
              className="m-auto flex max-w-sm flex-col items-center gap-3 p-6 text-center"
            >
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <MessagesSquare aria-hidden="true" className="size-6" />
              </div>
              <h1 className="font-medium">Your conversations</h1>
              <p className="text-sm text-muted-foreground">
                {chat.users.length === 0
                  ? 'Nobody else is online yet. Open this page in a second tab and join with another name to try it out.'
                  : 'Pick someone from the list to start chatting. Messages are saved, so the conversation will still be here when you come back.'}
              </p>
            </motion.div>
          ) : (
            // Keyed by the person: switching conversations fades the new one in. There is no
            // exit animation, so the switch itself is never held up.
            <motion.div
              key={chat.selected}
              variants={fade}
              initial="hidden"
              animate="visible"
              className="flex min-h-0 flex-1 flex-col"
            >
              <header className="flex items-center gap-3 border-b px-3 py-3 sm:px-4">
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden"
                  onClick={chat.closeConversation}
                >
                  <ArrowLeft aria-hidden="true" />
                  <span className="sr-only">Back to people</span>
                </Button>
                <UserAvatar username={chat.selected} online={chat.selectedOnline} className="size-9" />
                <div className="min-w-0">
                  <h1 className="truncate font-medium">{chat.selected}</h1>
                  <p className="text-xs text-muted-foreground">{chat.selectedOnline ? 'Online' : 'Offline'}</p>
                </div>
              </header>
              <MessageList key={chat.selected} counterpart={chat.selected} conversation={chat.conversation} />
              <MessageComposer
                key={`composer-${chat.selected}`}
                recipient={chat.selected}
                canSend={chat.canSend}
                blockedReason={blockedReason}
                onSend={chat.sendMessage}
              />
            </motion.div>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
