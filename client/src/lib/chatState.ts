import { UNCONFIRMED, fromServer, mergeConfirmed, type LocalMessage } from '@/lib/messages'
import { comparePositions } from '@/lib/positions'
import type {
  ConversationSummary,
  HistoryErrorPayload,
  HistoryPayload,
  IdentityKind,
  LoggedInPayload,
  Message,
  Position,
  PublicUser,
  UserLeftPayload,
} from '@/types/protocol'

// All chat state and every way it can change, as a pure reducer: no socket, no storage,
// no timers. The socket wiring lives in useChat; this file only answers "given this state
// and this event, what is the next state?". What the screen shows is derived from the
// state in chatSelectors.ts; how messages merge is in messages.ts.

/** Someone a direct chat can be opened with before any conversation exists. */
export interface Peer {
  userId: string
  username: string
}

/** One conversation as this client holds it. */
export interface Thread {
  /** What the server last said about it. `null` for a chat nobody has written in yet. */
  summary: ConversationSummary | null
  /** Direct chats opened from the people list: who it is with, until a summary says so. */
  peer: Peer | null
  messages: LocalMessage[]
  /** Messages from others that have not been on screen. */
  unread: number
  /** Why the last history request for this conversation failed, if it did. */
  error: string | null
  /** Whether the server has messages older than the oldest one held here. */
  hasMore: boolean
  /** A request for earlier messages is waiting for its answer. */
  loadingEarlier: boolean
  /**
   * Where the "New messages" line goes while this conversation is open: after this
   * position (`null`: before everything). `undefined`: there was nothing unread.
   */
  unreadFrom: Position | null | undefined
}

export type Phase =
  /** No identity: show the entry screen. */
  | 'loggedOut'
  /** A login is in flight, or a session is held and the socket is not yet (re)connected. */
  | 'authenticating'
  | 'loggedIn'
  /** The server closed this connection because the session was taken over elsewhere. */
  | 'replaced'

export interface ChatState {
  phase: Phase
  /** The logged-in user's permanent id; `null` until the server has said. */
  userId: string | null
  /** The logged-in (or logging-back-in) username; `null` while logged out. */
  username: string | null
  /** Guest or account; `null` until the server has said. */
  kind: IdentityKind | null
  admin: boolean
  loginError: string | null
  /** Increases with every `loggedin`, so effects can react to each (re)login. */
  loginCount: number
  /** Everyone connected, including this user. */
  onlineUsers: PublicUser[]
  /** Where the deployment lists them: every account, connected or not. Otherwise `null`. */
  directory: PublicUser[] | null
  /** The open conversation, by id. */
  selected: string | null
  /**
   * Whether the page is actually being looked at. A conversation that is open in a tab
   * nobody is looking at is not being read.
   */
  attentive: boolean
  /** By conversation id. */
  threads: Record<string, Thread>
  /** The latest message received from someone else, for announcing it to screen readers. */
  lastIncoming: { id: string; fromName: string; conversationId: string } | null
}

export type ChatAction =
  | { type: 'loginRequested' }
  | { type: 'loggedIn'; payload: LoggedInPayload }
  | { type: 'loginFailed'; message: string }
  | { type: 'loggedOut' }
  /** The guest who is logged in has just become an account. */
  | { type: 'becameAccount'; admin: boolean }
  | { type: 'disconnected'; replaced: boolean }
  | { type: 'userJoined'; payload: PublicUser }
  | { type: 'userLeft'; payload: UserLeftPayload }
  | { type: 'memberJoined'; payload: PublicUser }
  | { type: 'memberLeft'; payload: UserLeftPayload }
  | { type: 'conversationUpdated'; conversation: ConversationSummary }
  /** `peer` is given when the conversation is opened from the people list. */
  | { type: 'conversationSelected'; conversationId: string; peer?: Peer }
  | { type: 'conversationClosed' }
  /** The page was hidden (another tab, a minimised window) or shown again. */
  | { type: 'attentionChanged'; attentive: boolean }
  | { type: 'earlierRequested'; conversationId: string }
  | { type: 'historyLoaded'; payload: HistoryPayload }
  | { type: 'historyFailed'; payload: HistoryErrorPayload }
  | { type: 'messageReceived'; payload: Message; receivedAt: number }
  /** This client told the server how far it has read. */
  | { type: 'readUpTo'; conversationId: string; position: Position }
  | { type: 'sendStarted'; conversationId: string; clientId: string; text: string; timestamp: number }
  | { type: 'sendConfirmed'; conversationId: string; clientId: string; id: string; timestamp: number }
  | { type: 'sendFailed'; conversationId: string; clientId: string; reason: string }

export const EMPTY_THREAD: Thread = {
  summary: null,
  peer: null,
  messages: [],
  unread: 0,
  error: null,
  hasMore: false,
  loadingEarlier: false,
  unreadFrom: undefined,
}

export const initialChatState = (storedUsername: string | null): ChatState => ({
  phase: storedUsername === null ? 'loggedOut' : 'authenticating',
  userId: null,
  username: storedUsername,
  kind: null,
  admin: false,
  loginError: null,
  loginCount: 0,
  onlineUsers: [],
  directory: null,
  selected: null,
  attentive: true,
  threads: {},
  lastIncoming: null,
})

// ---------- threads

const threadOf = (state: ChatState, conversationId: string): Thread => state.threads[conversationId] ?? EMPTY_THREAD

const withThread = (state: ChatState, conversationId: string, update: (thread: Thread) => Thread): ChatState => ({
  ...state,
  threads: { ...state.threads, [conversationId]: update(threadOf(state, conversationId)) },
})

const updateOwnMessage = (
  state: ChatState,
  conversationId: string,
  clientId: string,
  update: (message: LocalMessage) => LocalMessage,
): ChatState =>
  withThread(state, conversationId, thread => ({
    ...thread,
    messages: thread.messages.map(message => (message.clientId === clientId ? update(message) : message)),
  }))

/** Pending messages can no longer be acknowledged once the connection is gone. */
const failPending = (threads: ChatState['threads']): ChatState['threads'] =>
  Object.fromEntries(
    Object.entries(threads).map(([id, thread]) => [
      id,
      {
        ...thread,
        loadingEarlier: false,
        messages: thread.messages.map(message =>
          message.status === 'pending' ? { ...message, status: 'failed' as const, error: UNCONFIRMED } : message,
        ),
      },
    ]),
  )

/** Whether a conversation is being read right now: it is the open one, and the page is being looked at. */
const isOnScreen = (state: ChatState, conversationId: string) => state.selected === conversationId && state.attentive

// Opening a conversation (or coming back to the page it is open on) reads it. Where
// reading had left off is kept, so that what is new can be pointed out.
const readNow = (state: ChatState, thread: Thread): Thread => {
  const own = thread.summary?.members.find(member => member.userId === state.userId)
  return {
    ...thread,
    unreadFrom: thread.unread > 0 ? (own?.readUpTo ?? null) : thread.unreadFrom,
    unread: 0,
  }
}

/** The server's word on a conversation replaces what was known; what is on screen is read. */
const withSummary = (state: ChatState, summary: ConversationSummary): ChatState =>
  withThread(state, summary.id, thread => ({
    ...thread,
    summary,
    unread: isOnScreen(state, summary.id) ? 0 : summary.unreadCount,
  }))

// Keeps the list preview in step with messages this client has seen arrive or be
// confirmed, between the server's own updates.
const withLastMessage = (thread: Thread, message: LocalMessage): Thread => {
  if (thread.summary === null || message.id === null) return thread
  const last = thread.summary.lastMessage
  const position = { ts: message.timestamp, id: message.id }
  if (last !== null && comparePositions(position, { ts: last.timestamp, id: last.id }) <= 0) return thread
  const preview = message.text.trim().replace(/\s+/g, ' ')
  return {
    ...thread,
    summary: {
      ...thread.summary,
      lastMessage: {
        id: message.id,
        from: message.from,
        fromName: message.fromName,
        preview: preview.length > 80 ? `${preview.slice(0, 80)}…` : preview,
        timestamp: message.timestamp,
      },
    },
  }
}

const upsertUser = (users: PublicUser[], user: PublicUser) => [
  ...users.filter(candidate => candidate.userId !== user.userId),
  user,
]

// ---------- reducer

export const chatReducer = (state: ChatState, action: ChatAction): ChatState => {
  switch (action.type) {
    case 'loginRequested':
      // The username is only adopted once the server accepts it (`loggedIn`): until then a
      // first login still shows the form, and a re-login keeps the name it already has.
      return { ...state, phase: 'authenticating', loginError: null }

    case 'loggedIn': {
      const { payload } = action
      // The same name can come back as a different identity (a guest name that lapsed while
      // this tab slept and was reserved afresh). Nothing held for the old one belongs to
      // the new one: not its conversations, not what was open.
      const sameIdentity = state.userId === null || state.userId === payload.userId
      const next: ChatState = {
        ...state,
        ...(sameIdentity ? {} : { threads: {}, selected: null, lastIncoming: null }),
        phase: 'loggedIn',
        userId: payload.userId,
        username: payload.username,
        kind: payload.kind,
        admin: payload.admin,
        loginError: null,
        loginCount: state.loginCount + 1,
        // The snapshots replace whatever was known before.
        onlineUsers: payload.onlineUsers,
        directory: payload.members ?? null,
      }
      // Conversations keep the messages already loaded; the server's summaries are laid over them.
      return payload.conversations.reduce(withSummary, next)
    }

    case 'loginFailed':
      // Back to the form with nothing carried over: whoever logs in next may be someone else.
      return { ...initialChatState(null), loginError: action.message }

    case 'loggedOut':
      return initialChatState(null)

    case 'becameAccount':
      return { ...state, kind: 'account', admin: action.admin }

    case 'disconnected': {
      if (state.username === null) return state
      return {
        ...state,
        phase: action.replaced ? 'replaced' : 'authenticating',
        threads: failPending(state.threads),
      }
    }

    case 'userJoined':
      return { ...state, onlineUsers: upsertUser(state.onlineUsers, action.payload) }

    case 'userLeft':
      return { ...state, onlineUsers: state.onlineUsers.filter(user => user.userId !== action.payload.userId) }

    case 'memberJoined':
      return state.directory === null ? state : { ...state, directory: upsertUser(state.directory, action.payload) }

    case 'memberLeft':
      return state.directory === null
        ? state
        : { ...state, directory: state.directory.filter(user => user.userId !== action.payload.userId) }

    case 'conversationUpdated':
      return withSummary(state, action.conversation)

    case 'conversationSelected': {
      const { conversationId, peer } = action
      const selected = withThread(state, conversationId, thread => {
        // The line from the last visit is not carried over to this one.
        const opened = { ...thread, peer: peer ?? thread.peer, unreadFrom: undefined }
        // Opened in a page nobody is looking at: it is read when they look.
        return state.attentive ? readNow(state, opened) : opened
      })
      return { ...selected, selected: conversationId }
    }

    case 'attentionChanged': {
      const next = { ...state, attentive: action.attentive }
      if (!action.attentive || next.selected === null) return next
      return withThread(next, next.selected, thread => readNow(next, thread))
    }

    case 'conversationClosed':
      return { ...state, selected: null }

    case 'earlierRequested':
      return withThread(state, action.conversationId, thread => ({ ...thread, loadingEarlier: true }))

    case 'historyLoaded': {
      const ownUserId = state.userId
      if (ownUserId === null) return state
      const { conversationId, messages, hasMore } = action.payload
      // Applied to the conversation the response names, whichever one is on screen now.
      return withThread(state, conversationId, thread => {
        const page = messages.map(message => fromServer(message, ownUserId, null))
        // A page that starts after everything held, with more before it, does not join
        // up with what is held: messages are missing in between (more than a page arrived
        // while this client was away). What is held from before the gap is let go, so
        // that the conversation is continuous again and "load earlier" pages back through
        // the gap instead of skipping it. The user's own unconfirmed messages are kept.
        const newestHeld = thread.messages.findLast(message => message.id !== null)
        const disjoint =
          hasMore &&
          messages.length > 0 &&
          newestHeld !== undefined &&
          newestHeld.id !== null &&
          comparePositions(
            { ts: messages[0].timestamp, id: messages[0].id },
            { ts: newestHeld.timestamp, id: newestHeld.id },
          ) > 0
        const merged = mergeConfirmed(
          disjoint ? thread.messages.filter(message => message.id === null) : thread.messages,
          page,
        )
        // `hasMore` speaks about what lies before this page. It only says something new
        // if this page reaches back at least as far as anything already held.
        const oldestHeld = merged.find(message => message.id !== null)
        const reachesBack = messages.length === 0 || oldestHeld === undefined || oldestHeld.id === messages[0].id
        return {
          ...thread,
          error: null,
          loadingEarlier: false,
          hasMore: reachesBack ? hasMore : thread.hasMore,
          messages: merged,
        }
      })
    }

    case 'historyFailed': {
      const { conversationId, message } = action.payload
      if (conversationId === null) return state
      return withThread(state, conversationId, thread => ({ ...thread, error: message, loadingEarlier: false }))
    }

    case 'messageReceived': {
      if (state.userId === null) return state
      const { conversationId, id, fromName } = action.payload
      const message = fromServer(action.payload, state.userId, action.receivedAt)
      const alreadyKnown = threadOf(state, conversationId).messages.some(candidate => candidate.id === id)
      // The user's own message, sent from another of their devices, is not news to them.
      const counts = !message.own && !alreadyKnown
      const next = withThread(state, conversationId, thread =>
        withLastMessage(
          {
            ...thread,
            messages: mergeConfirmed(thread.messages, [message]),
            unread: counts && !isOnScreen(state, conversationId) ? thread.unread + 1 : thread.unread,
          },
          message,
        ),
      )
      return counts ? { ...next, lastIncoming: { id, fromName, conversationId } } : next
    }

    case 'readUpTo': {
      const { conversationId, position } = action
      return withThread(state, conversationId, thread => {
        if (thread.summary === null) return thread
        return {
          ...thread,
          summary: {
            ...thread.summary,
            members: thread.summary.members.map(member =>
              member.userId === state.userId && comparePositions(position, member.readUpTo) > 0
                ? { ...member, readUpTo: position }
                : member,
            ),
          },
        }
      })
    }

    case 'sendStarted': {
      if (state.userId === null || state.username === null) return state
      const pending: LocalMessage = {
        key: action.clientId,
        id: null,
        clientId: action.clientId,
        from: state.userId,
        fromName: state.username,
        kind: 'text',
        text: action.text,
        timestamp: action.timestamp,
        own: true,
        status: 'pending',
        arrivedAt: action.timestamp,
      }
      return withThread(state, action.conversationId, thread => ({
        ...thread,
        messages: [...thread.messages, pending],
      }))
    }

    case 'sendConfirmed': {
      const confirmed = updateOwnMessage(state, action.conversationId, action.clientId, message => ({
        ...message,
        id: action.id,
        timestamp: action.timestamp,
        status: 'sent',
        error: undefined,
      }))
      // Re-merge so the message takes its place in server order, and so a copy that
      // history already confirmed under the same id collapses into one entry.
      return withThread(confirmed, action.conversationId, thread => {
        const messages = mergeConfirmed(thread.messages, [])
        const sent = messages.find(message => message.id === action.id)
        return sent === undefined ? { ...thread, messages } : withLastMessage({ ...thread, messages }, sent)
      })
    }

    case 'sendFailed':
      return updateOwnMessage(state, action.conversationId, action.clientId, message =>
        // A late failure must not downgrade a message that has since been confirmed.
        message.id === null ? { ...message, status: 'failed', error: action.reason } : message,
      )
  }
}
