import { useState, type DragEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Info, MessagesSquare } from 'lucide-react'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import { EntryScreen } from '@/components/EntryScreen'
import { GroupAvatar } from '@/components/groups/GroupAvatar'
import { GroupDetails } from '@/components/groups/GroupDetails'
import { NewGroupDialog } from '@/components/groups/NewGroupDialog'
import { MessageComposer, type ComposerFiles } from '@/components/MessageComposer'
import { MessageList } from '@/components/MessageList'
import { Sidebar } from '@/components/Sidebar'
import { Button } from '@/components/ui/button'
import { UserAvatar } from '@/components/UserAvatar'
import { useChat } from '@/hooks/useChat'
import { useDraftFiles } from '@/hooks/useDraftFiles'
import type { Candidate, OpenGroup } from '@/lib/chatSelectors'
import { fade } from '@/lib/motion'
import { useServerConfig, type ServerConfig } from '@/lib/serverConfig'
import { presenceLineOf } from '@/lib/status'
import { cn } from '@/lib/utils'
import type { Features } from '@/types/protocol'

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

interface GroupDetailsButtonProps {
  conversationId: string
  group: OpenGroup
  candidates: Candidate[]
  online: boolean
}

// The way into a group's details. Lives inside the open conversation, so the panel
// closes by itself when another conversation is opened — or when this one is taken away.
function GroupDetailsButton(props: GroupDetailsButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="icon" className="ml-auto" onClick={() => setOpen(true)}>
        <Info aria-hidden="true" />
        <span className="sr-only">Group details</span>
      </Button>
      {open && <GroupDetails {...props} onClose={() => setOpen(false)} />}
    </>
  )
}

function ChatShell({ chat, config, username }: { chat: ReturnType<typeof useChat>; config: ServerConfig; username: string }) {
  const [creatingGroup, setCreatingGroup] = useState(false)
  const online = chat.connected && chat.phase === 'loggedIn'

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
            files: chat.features.files,
            config,
            online,
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
          onNewGroup={() => setCreatingGroup(true)}
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
                {open.group === null ? (
                  <UserAvatar username={open.title} presence={open.presence ?? undefined} className="size-9" />
                ) : (
                  <GroupAvatar
                    names={open.group.memberNames}
                    className="size-9"
                  />
                )}
                <div className="min-w-0">
                  <h1 className="truncate font-medium">{open.title}</h1>
                  <p className="truncate text-xs text-muted-foreground">
                    {open.group !== null
                      ? `${open.group.members.length} ${open.group.members.length === 1 ? 'member' : 'members'}: ${open.group.members.map(member => (member.own ? 'you' : member.username)).join(', ')}`
                      : open.counterpart?.gone
                      ? 'No longer here'
                      : open.presence === null
                        ? ''
                        : open.presence === 'offline'
                          ? 'Offline — they will see your messages when they are back'
                          : presenceLineOf({ kind: open.kind, presence: open.presence, statusText: open.statusText })}
                  </p>
                </div>
                {open.group !== null && (
                  <GroupDetailsButton conversationId={open.id} group={open.group} candidates={chat.candidates} online={online} />
                )}
              </header>
              <ConversationBody
                key={open.id}
                conversationId={open.id}
                // Sending files is for accounts; anyone can receive them.
                filesUnavailable={chat.kind === 'account' ? null : 'Create an account to send files'}
                features={chat.features}
                canSend={chat.canSend}
                list={
                  <MessageList
                    title={open.title}
                    thread={chat.thread}
                    ownUserId={chat.userId}
                    group={open.group !== null}
                    joinedLater={open.group?.joinedLater === true}
                    canDelete={online}
                    onLoadEarlier={chat.loadEarlier}
                    onAtEndChange={chat.reportAtEnd}
                  />
                }
                composer={files => (
                  <MessageComposer
                    recipient={open.title}
                    canSend={chat.canSend}
                    blockedReason={blockedReason}
                    onSend={chat.sendMessage}
                    files={files}
                  />
                )}
              />
            </motion.div>
          )}
        </main>
      </div>
      {creatingGroup && (
        <NewGroupDialog
          candidates={chat.candidates}
          onCreated={chat.selectConversation}
          onClose={() => setCreatingGroup(false)}
        />
      )}
    </div>
  )
}

interface ConversationBodyProps {
  conversationId: string
  features: Features
  filesUnavailable: string | null
  canSend: boolean
  list: ReactNode
  composer: (files: ComposerFiles | undefined) => ReactNode
}

// The open conversation below its header: the messages, and the box to write in. The
// files being attached belong to both — they are dropped onto the messages and listed
// above the box — so they are held here.
function ConversationBody({ conversationId, features, filesUnavailable, canSend, list, composer }: ConversationBodyProps) {
  const drafts = useDraftFiles({ conversationId, maxFileBytes: features.maxFileBytes })
  const [over, setOver] = useState(false)
  const droppable = features.files && filesUnavailable === null && canSend
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={event => droppable && carriesFiles(event) && setOver(true)}
      onDragOver={event => {
        // (Without this the browser would open a dropped file instead.)
        if (droppable && carriesFiles(event)) event.preventDefault()
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={event => {
        if (!droppable || !carriesFiles(event)) return
        event.preventDefault()
        setOver(false)
        drafts.add([...event.dataTransfer.files])
      }}
    >
      {list}
      {composer(features.files ? { ...drafts, unavailable: filesUnavailable } : undefined)}
      {over && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85 text-sm font-medium"
        >
          Drop files to send them
        </div>
      )}
    </div>
  )
}

export default App
