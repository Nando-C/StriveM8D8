import type {
  ChatMessage,
  HistoryErrorPayload,
  HistoryMessage,
  HistoryPayload,
  IdentityKind,
  LoggedInPayload,
  NewLoginPayload,
  OnlineUser,
  UserLeftPayload,
} from '@/types/protocol'

// All chat state and every way it can change, as a pure reducer: no socket, no storage,
// no timers. The socket wiring lives in useChat; this file only answers "given this state
// and this event, what is the next state?".

export type MessageStatus = 'sent' | 'pending' | 'failed'

/** One message as the UI shows it, whether it arrived live, from history, or was typed here. */
export interface LocalMessage {
  /** Stable React key: survives the pending → sent transition of the user's own messages. */
  key: string
  /** The server's id. `null` until the server has confirmed the message. */
  id: string | null
  /** The id this client generated when sending. `null` for messages it did not send. */
  clientId: string | null
  from: string
  text: string
  timestamp: number
  /** Sent by the logged-in user. */
  own: boolean
  status: MessageStatus
  /** Why a failed message failed. */
  error?: string
  /**
   * When this client saw the message arrive or sent it (its own clock), or `null` for a
   * message that came from history. Only used to decide whether it animates in.
   */
  arrivedAt: number | null
}

export interface Conversation {
  messages: LocalMessage[]
  /** Messages received while this conversation was not the one on screen. */
  unread: number
  /** Why the last history request for this conversation failed, if it did. */
  error: string | null
}

export type Phase =
  /** No identity: show the login form. */
  | 'loggedOut'
  /** A login is in flight, or a session is held and the socket is not yet (re)connected. */
  | 'authenticating'
  | 'loggedIn'
  /** The server closed this connection because the session was taken over elsewhere. */
  | 'replaced'

export interface ChatState {
  phase: Phase
  /** The logged-in (or logging-back-in) username; `null` while logged out. */
  username: string | null
  /** Guest or account; `null` until the server has said. */
  kind: IdentityKind | null
  admin: boolean
  loginError: string | null
  /** Increases with every `loggedin`, so effects can react to each (re)login. */
  loginCount: number
  onlineUsers: OnlineUser[]
  /** The open conversation, by username — socket ids change on reconnect, names do not. */
  selected: string | null
  conversations: Record<string, Conversation>
  /** The latest message received from someone else, for announcing it to screen readers. */
  lastIncoming: { id: string; from: string } | null
}

export type ChatAction =
  | { type: 'loginRequested' }
  | { type: 'loggedIn'; payload: LoggedInPayload }
  | { type: 'loginFailed'; message: string }
  | { type: 'loggedOut' }
  /** The guest who is logged in has just become an account. */
  | { type: 'becameAccount'; admin: boolean }
  | { type: 'disconnected'; replaced: boolean }
  | { type: 'userJoined'; payload: NewLoginPayload }
  | { type: 'userLeft'; payload: UserLeftPayload }
  | { type: 'conversationSelected'; username: string }
  | { type: 'conversationClosed' }
  | { type: 'historyLoaded'; payload: HistoryPayload }
  | { type: 'historyFailed'; payload: HistoryErrorPayload }
  | { type: 'messageReceived'; payload: ChatMessage; receivedAt: number }
  | { type: 'sendStarted'; to: string; clientId: string; text: string; timestamp: number }
  | { type: 'sendConfirmed'; to: string; clientId: string; id: string; timestamp: number }
  | { type: 'sendFailed'; to: string; clientId: string; reason: string }

export const UNCONFIRMED = 'Delivery unconfirmed: the connection was lost'

const EMPTY_CONVERSATION: Conversation = { messages: [], unread: 0, error: null }

export const initialChatState = (storedUsername: string | null): ChatState => ({
  phase: storedUsername === null ? 'loggedOut' : 'authenticating',
  username: storedUsername,
  kind: null,
  admin: false,
  loginError: null,
  loginCount: 0,
  onlineUsers: [],
  selected: null,
  conversations: {},
  lastIncoming: null,
})

// ---------- messages

const fromHistory = (message: HistoryMessage, ownUsername: string): LocalMessage => {
  const own = message.from === ownUsername
  return {
    // The user's own messages keep the key they had while pending (their clientId).
    key: own && message.clientId !== null ? message.clientId : message.id,
    id: message.id,
    clientId: message.clientId,
    from: message.from,
    text: message.text,
    timestamp: message.timestamp,
    own,
    status: 'sent',
    arrivedAt: null,
  }
}

const fromLive = (message: ChatMessage, arrivedAt: number): LocalMessage => ({
  key: message.id,
  id: message.id,
  clientId: null,
  from: message.from,
  text: message.text,
  timestamp: message.timestamp,
  own: false,
  status: 'sent',
  arrivedAt,
})

const byTimeThenId = (a: LocalMessage, b: LocalMessage) =>
  a.timestamp - b.timestamp || (a.id ?? '').localeCompare(b.id ?? '')

/**
 * Merges server-confirmed messages into a conversation. Never appends or replaces blindly:
 *
 * - confirmed messages are unique by server id, so a message received live and then again
 *   in history appears once;
 * - the user's unconfirmed messages (pending or failed, no server id yet) are kept, after
 *   the confirmed ones — unless a confirmed message carries the same clientId, in which
 *   case that local item *is* that message and the confirmed one takes its place. That is
 *   what rescues a send whose acknowledgement was lost.
 */
export const mergeConfirmed = (existing: LocalMessage[], incoming: LocalMessage[]): LocalMessage[] => {
  const confirmed = new Map<string, LocalMessage>()
  for (const message of existing) {
    if (message.id !== null) confirmed.set(message.id, message)
  }
  for (const message of incoming) {
    if (message.id !== null) confirmed.set(message.id, message)
  }

  const confirmedClientIds = new Set<string>()
  for (const message of confirmed.values()) {
    if (message.clientId !== null) confirmedClientIds.add(message.clientId)
  }

  const unconfirmed = existing.filter(
    message => message.id === null && !(message.clientId !== null && confirmedClientIds.has(message.clientId)),
  )

  return [...[...confirmed.values()].sort(byTimeThenId), ...unconfirmed]
}

// ---------- conversations

const conversationOf = (state: ChatState, username: string): Conversation =>
  state.conversations[username] ?? EMPTY_CONVERSATION

const withConversation = (
  state: ChatState,
  username: string,
  update: (conversation: Conversation) => Conversation,
): ChatState => ({
  ...state,
  conversations: { ...state.conversations, [username]: update(conversationOf(state, username)) },
})

const updateOwnMessage = (
  state: ChatState,
  to: string,
  clientId: string,
  update: (message: LocalMessage) => LocalMessage,
): ChatState =>
  withConversation(state, to, conversation => ({
    ...conversation,
    messages: conversation.messages.map(message => (message.clientId === clientId ? update(message) : message)),
  }))

/** Pending messages can no longer be acknowledged once the connection is gone. */
const failPending = (conversations: ChatState['conversations']): ChatState['conversations'] =>
  Object.fromEntries(
    Object.entries(conversations).map(([username, conversation]) => [
      username,
      {
        ...conversation,
        messages: conversation.messages.map(message =>
          message.status === 'pending' ? { ...message, status: 'failed' as const, error: UNCONFIRMED } : message,
        ),
      },
    ]),
  )

// ---------- reducer

export const chatReducer = (state: ChatState, action: ChatAction): ChatState => {
  switch (action.type) {
    case 'loginRequested':
      // The username is only adopted once the server accepts it (`loggedIn`): until then a
      // first login still shows the form, and a re-login keeps the name it already has.
      return { ...state, phase: 'authenticating', loginError: null }

    case 'loggedIn':
      return {
        ...state,
        phase: 'loggedIn',
        username: action.payload.username,
        kind: action.payload.kind,
        admin: action.payload.admin,
        loginError: null,
        loginCount: state.loginCount + 1,
        // The snapshot replaces whatever was known before.
        onlineUsers: action.payload.onlineUsers,
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
        conversations: failPending(state.conversations),
      }
    }

    case 'userJoined': {
      const { username, id } = action.payload
      // Upsert by username; also drop any other entry holding the same id.
      const others = state.onlineUsers.filter(user => user.username !== username && user.id !== id)
      return { ...state, onlineUsers: [...others, { username, id }] }
    }

    case 'userLeft':
      return { ...state, onlineUsers: state.onlineUsers.filter(user => user.id !== action.payload.id) }

    case 'conversationSelected':
      return {
        ...withConversation(state, action.username, conversation => ({ ...conversation, unread: 0 })),
        selected: action.username,
      }

    case 'conversationClosed':
      return { ...state, selected: null }

    case 'historyLoaded': {
      const ownUsername = state.username
      if (ownUsername === null) return state
      const { withUsername, messages } = action.payload
      // Applied to the conversation the response names, whichever one is on screen now.
      return withConversation(state, withUsername, conversation => ({
        ...conversation,
        error: null,
        messages: mergeConfirmed(
          conversation.messages,
          messages.map(message => fromHistory(message, ownUsername)),
        ),
      }))
    }

    case 'historyFailed': {
      const { withUsername, message } = action.payload
      if (withUsername === null) return state
      return withConversation(state, withUsername, conversation => ({ ...conversation, error: message }))
    }

    case 'messageReceived': {
      const { from } = action.payload
      const alreadyKnown = conversationOf(state, from).messages.some(message => message.id === action.payload.id)
      const next = withConversation(state, from, conversation => ({
        ...conversation,
        messages: mergeConfirmed(conversation.messages, [fromLive(action.payload, action.receivedAt)]),
        unread: state.selected === from || alreadyKnown ? conversation.unread : conversation.unread + 1,
      }))
      return alreadyKnown ? next : { ...next, lastIncoming: { id: action.payload.id, from } }
    }

    case 'sendStarted': {
      if (state.username === null) return state
      const pending: LocalMessage = {
        key: action.clientId,
        id: null,
        clientId: action.clientId,
        from: state.username,
        text: action.text,
        timestamp: action.timestamp,
        own: true,
        status: 'pending',
        arrivedAt: action.timestamp,
      }
      return withConversation(state, action.to, conversation => ({
        ...conversation,
        messages: [...conversation.messages, pending],
      }))
    }

    case 'sendConfirmed': {
      const confirmed = updateOwnMessage(state, action.to, action.clientId, message => ({
        ...message,
        id: action.id,
        timestamp: action.timestamp,
        status: 'sent',
        error: undefined,
      }))
      // Re-merge so the message takes its place in server order, and so a copy that
      // history already confirmed under the same id collapses into one entry.
      return withConversation(confirmed, action.to, conversation => ({
        ...conversation,
        messages: mergeConfirmed(conversation.messages, []),
      }))
    }

    case 'sendFailed':
      return updateOwnMessage(state, action.to, action.clientId, message =>
        // A late failure must not downgrade a message that has since been confirmed.
        message.id === null ? { ...message, status: 'failed', error: action.reason } : message,
      )
  }
}

// ---------- selectors

/** Everyone online except the logged-in user (matched by name: ids change on reconnect). */
export const otherOnlineUsers = (state: ChatState): OnlineUser[] =>
  state.onlineUsers.filter(user => user.username !== state.username)

/** The selected user's current socket id, looked up fresh; `null` if they are offline. */
export const selectedUserId = (state: ChatState): string | null =>
  state.onlineUsers.find(user => user.username === state.selected)?.id ?? null

export const selectedConversation = (state: ChatState): Conversation =>
  state.selected === null ? EMPTY_CONVERSATION : conversationOf(state, state.selected)
