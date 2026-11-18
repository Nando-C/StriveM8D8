import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, MessagesSquare } from 'lucide-react'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import { EntryScreen } from '@/components/EntryScreen'
import { MessageComposer } from '@/components/MessageComposer'
import { MessageList } from '@/components/MessageList'
import { Sidebar } from '@/components/Sidebar'
import { Button } from '@/components/ui/button'
import { UserAvatar } from '@/components/UserAvatar'
import { useChat } from '@/hooks/useChat'
import { fade } from '@/lib/motion'
import { useServerConfig, type ServerConfig } from '@/lib/serverConfig'
import { presenceLine } from '@/lib/status'
import { cn } from '@/lib/utils'

function App() {
  const chat = useChat()
  const config = useServerConfig()

  if (chat.outdated) return <OutdatedNotice />

  // The login form and the chat cross-fade into each other.
  return (
    <AnimatePresence mode="wait" initial={false}>
      {chat.username === null ? (
        // No identity yet (or the last login was refused): the login form is the whole screen.
        <motion.div key="login" variants={fade} initial="hidden" animate="visible" exit="exit">
          <EntryScreen
            config={config}
            connected={chat.connected}
            pending={chat.phase === 'authenticating'}
            error={chat.loginError}
            onGuest={chat.login}
            onSignIn={chat.signIn}
            onAccountCreated={chat.signInWithSession}
          />
        </motion.div>
      ) : (
        <motion.div key="chat" variants={fade} initial="hidden" animate="visible" exit="exit">
          <ChatShell chat={chat} config={config} username={chat.username} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** The server speaks a newer version of the protocol than this page was built for. */
function OutdatedNotice() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <div role="alert" className="flex max-w-sm flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <MessagesSquare aria-hidden="true" className="size-5" />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="font-medium">A new version is available</h1>
          <p className="text-sm text-muted-foreground">
            Strive Chat was updated while this page was open. Reload to carry on — nothing is lost.
          </p>
        </div>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    </main>
  )
}

function ChatShell({ chat, config, username }: { chat: ReturnType<typeof useChat>; config: ServerConfig; username: string }) {

  const open = chat.open
  const blockedReason = !chat.connected
    ? 'Disconnected'
    : chat.phase !== 'loggedIn'
      ? 'Signing in…'
      : open?.counterpart?.gone
        ? `${open.title} is no longer here`
        : null

  // Announce messages that arrive in a conversation that is not on screen; the open
  // conversation announces its own through the message list.
  const offscreen = chat.lastIncoming !== null && chat.lastIncoming.conversationId !== chat.selected ? chat.lastIncoming : null

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
        {offscreen !== null && <span key={offscreen.id}>New message from {offscreen.fromName}</span>}
      </p>
      <div className="flex min-h-0 flex-1">
        {/* On a phone the list and the conversation are separate views; from md up they sit side by side. */}
        <Sidebar
          username={username}
          account={{
            kind: chat.kind,
            admin: chat.admin,
            config,
            online: chat.connected && chat.phase === 'loggedIn',
            ownStatus: chat.ownStatus,
            onSetStatus: chat.setStatus,
            onBecameAccount: chat.becomeAccount,
            onLogout: chat.logout,
            onDeleted: chat.forget,
          }}
          chats={chat.chats}
          people={chat.people}
          listsEveryone={chat.listsEveryone}
          selected={chat.selected}
          selectedUserId={open?.counterpart?.userId ?? null}
          onSelectChat={chat.selectConversation}
          onSelectPerson={chat.openChatWith}
          className={cn('w-full md:w-72 md:shrink-0', open !== null && 'hidden md:flex')}
        />
        <main className={cn('min-w-0 flex-1 flex-col', open === null ? 'hidden md:flex' : 'flex')}>
          {open === null ? (
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
                {chat.people.length === 0 && chat.chats.length === 0
                  ? 'Nobody else is online yet. Open this page in a second tab and join with another name to try it out.'
                  : 'Pick a chat or a person from the list. Messages are saved and delivered even if the other person is away, so the conversation will be here when either of you comes back.'}
              </p>
            </motion.div>
          ) : (
            // Keyed by the person: switching conversations fades the new one in. There is no
            // exit animation, so the switch itself is never held up.
            <motion.div
              key={open.id}
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
                  <span className="sr-only">Back to chats</span>
                </Button>
                <UserAvatar username={open.title} presence={open.presence ?? undefined} className="size-9" />
                <div className="min-w-0">
                  <h1 className="truncate font-medium">{open.title}</h1>
                  <p className="text-xs text-muted-foreground">
                    {open.counterpart?.gone
                      ? 'No longer here'
                      : open.presence === null
                        ? ''
                        : open.presence === 'offline'
                          ? 'Offline — they will see your messages when they are back'
                          : presenceLine(
                              open.kind === 'guest' ? 'Guest' : open.kind === 'bot' ? 'Bot' : undefined,
                              open.presence,
                              open.statusText,
                            )}
                  </p>
                </div>
              </header>
              <MessageList
                key={open.id}
                title={open.title}
                thread={chat.thread}
                ownUserId={chat.userId}
                onLoadEarlier={chat.loadEarlier}
                onAtEndChange={chat.reportAtEnd}
              />
              <MessageComposer
                key={`composer-${open.id}`}
                recipient={open.title}
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
