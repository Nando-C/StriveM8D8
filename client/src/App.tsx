import { ConnectionBanner } from '@/components/ConnectionBanner'
import { LoginForm } from '@/components/LoginForm'
import { MessageComposer } from '@/components/MessageComposer'
import { MessageList } from '@/components/MessageList'
import { Sidebar } from '@/components/Sidebar'
import { useChat } from '@/hooks/useChat'

function App() {
  const chat = useChat()

  // No identity yet (or the last login was refused): the login form is the whole screen.
  if (chat.username === null) {
    return (
      <LoginForm
        connected={chat.connected}
        pending={chat.phase === 'authenticating'}
        error={chat.loginError}
        onLogin={chat.login}
      />
    )
  }

  const blockedReason = !chat.connected
    ? 'Disconnected'
    : chat.phase !== 'loggedIn'
      ? 'Signing in…'
      : !chat.selectedOnline
        ? `${chat.selected} is offline`
        : null

  return (
    <div className="flex h-svh flex-col">
      <ConnectionBanner
        connected={chat.connected}
        phase={chat.phase}
        username={chat.username}
        onReconnect={chat.reconnect}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          username={chat.username}
          users={chat.users}
          selected={chat.selected}
          selectedOnline={chat.selectedOnline}
          conversations={chat.conversations}
          onSelect={chat.selectConversation}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          {chat.selected === null ? (
            <p className="m-auto p-4 text-sm text-muted-foreground">Select someone to start chatting.</p>
          ) : (
            <>
              <header className="border-b p-4">
                <h1 className="font-medium">{chat.selected}</h1>
                <p className="text-xs text-muted-foreground">{chat.selectedOnline ? 'Online' : 'Offline'}</p>
              </header>
              <MessageList conversation={chat.conversation} />
              <MessageComposer
                key={chat.selected}
                recipient={chat.selected}
                canSend={chat.canSend}
                blockedReason={blockedReason}
                onSend={chat.sendMessage}
              />
            </>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
