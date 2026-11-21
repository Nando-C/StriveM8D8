import { UNCONFIRMED, asDeleted, fromServer, isSaid, mergeConfirmed, previewOf, type LocalMessage } from '@/lib/messages'
import { comparePositions, positionOf } from '@/lib/positions'
import type {
  Attachment,
  ConversationSummary,
  Features,
  HistoryErrorPayload,
  HistoryPayload,
  IdentityKind,
  LoggedInPayload,
  Member,
  Message,
  OwnStatus,
  Position,
  PresencePayload,
  PublicUser,
  ReceiptPayload,
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
  /**
   * Receipts that arrived before the server had described the conversation — a first
   * message can be received by the other person before that. Applied when it is described.
   */
  earlyReceipts?: ReceiptPayload[]
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
  /** What this deployment offers (file sharing, and its limits). */
  features: Features
  /** What the user has chosen to show; `null` until the server has said. */
  ownStatus: OwnStatus | null
  loginError: string | null
  /** Increases with every `loggedin`, so effects can react to each (re)login. */
  loginCount: number
  /** Everyone connected who can be seen (this user too, unless they are invisible). */
  onlineUsers: PublicUser[]
  /** Where the deployment lists them: every account, connected or not. Otherwise `null`. */
  directory: Member[] | null
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
  | { type: 'presenceChanged'; payload: PresencePayload }
  | { type: 'ownStatusChanged'; ownStatus: OwnStatus }
  | { type: 'memberJoined'; payload: Member }
  /** The whole directory, sent to someone who has just become entitled to it. */
  | { type: 'directoryReceived'; members: Member[] }
  | { type: 'memberLeft'; payload: UserLeftPayload }
  | { type: 'conversationUpdated'; conversation: ConversationSummary }
  /** The user is no longer in this group. */
  | { type: 'conversationRemoved'; conversationId: string }
  | { type: 'messageDeleted'; conversationId: string; id: string }
  /** `peer` is given when the conversation is opened from the people list. */
  | { type: 'conversationSelected'; conversationId: string; peer?: Peer }
  | { type: 'conversationClosed' }
  /** The page was hidden (another tab, a minimised window) or shown again. */
  | { type: 'attentionChanged'; attentive: boolean }
  | { type: 'earlierRequested'; conversationId: string }
  | { type: 'historyLoaded'; payload: HistoryPayload }
  | { type: 'historyFailed'; payload: HistoryErrorPayload }
  | { type: 'messageReceived'; payload: Message; receivedAt: number }
  /** Another member received or read further. */
  | { type: 'receipt'; payload: ReceiptPayload }
  /** This client told the server how far it has read. */
  | { type: 'readUpTo'; conversationId: string; position: Position }
  | { type: 'sendStarted'; conversationId: string; clientId: string; text: string; attachments?: Attachment[]; timestamp: number }
  | { type: 'sendConfirmed'; conversationId: string; clientId: string; id: string; timestamp: number }
  | { type: 'sendFailed'; conversationId: string; clientId: string; reason: string }

/** A server that says nothing about what it offers offers no files. */
const NO_FEATURES: Features = { files: false }

export const CONNECTION_LOST = 'The connection dropped before you were signed in. Please try again.'

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
  features: NO_FEATURES,
  ownStatus: null,
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

// Almost everything that happens to a conversation is about one already held: a page of
// history, a receipt, the outcome of a send. If it has gone meanwhile — the user was
// taken out of a group — such an answer changes nothing, and above all does not bring the
// conversation back as one of its own.
const withThread = (state: ChatState, conversationId: string, update: (thread: Thread) => Thread): ChatState =>
  state.threads[conversationId] === undefined ? state : withThreadBegun(state, conversationId, update)

// The few things that may begin a conversation here: the server describing it, a message
// arriving in it, the user opening it or writing in it.
const withThreadBegun = (state: ChatState, conversationId: string, update: (thread: Thread) => Thread): ChatState => ({
  ...state,
  threads: { ...state.threads, [conversationId]: update(threadOf(state, conversationId)) },
})

/** Lets go of conversations, and of whatever pointed at them. The same state if none of them is held. */
const withoutThreads = (state: ChatState, ids: ReadonlySet<string>): ChatState => {
  if (!Object.keys(state.threads).some(id => ids.has(id))) return state
  return {
    ...state,
    threads: Object.fromEntries(Object.entries(state.threads).filter(([id]) => !ids.has(id))),
    selected: state.selected !== null && ids.has(state.selected) ? null : state.selected,
    lastIncoming: state.lastIncoming !== null && ids.has(state.lastIncoming.conversationId) ? null : state.lastIncoming,
  }
}

/** The user's own entry among a conversation's members. */
export const ownMember = (summary: ConversationSummary | null | undefined, userId: string | null) =>
  summary?.members.find(member => member.userId === userId)

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
  const own = ownMember(thread.summary, state.userId)
  return {
    ...thread,
    unreadFrom: thread.unread > 0 ? (own?.readUpTo ?? null) : thread.unreadFrom,
    unread: 0,
  }
}

/** The server's word on a conversation replaces what was known; what is on screen is read. */
const withSummary = (state: ChatState, summary: ConversationSummary): ChatState =>
  withThreadBegun(state, summary.id, thread => ({
    ...thread,
    // (Positions only move forward, so a receipt that came first still holds.)
    summary: (thread.earlyReceipts ?? []).reduce(withReceipt, summary),
    earlyReceipts: undefined,
    messages: sinceJoining(thread.messages, ownMember(summary, state.userId)?.joinedAfter),
    unread: isOnScreen(state, summary.id) ? 0 : summary.unreadCount,
  }))

// Where a member stands, after a receipt. Positions only move forward: one that arrives
// late or twice changes nothing.
const withReceipt = (summary: ConversationSummary, { userId, deliveredUpTo, readUpTo }: ReceiptPayload): ConversationSummary => {
  const later = (current: Position | null, next: Position | null) => (comparePositions(next, current) > 0 ? next : current)
  return {
    ...summary,
    members: summary.members.map(member =>
      member.userId === userId
        ? { ...member, deliveredUpTo: later(member.deliveredUpTo, deliveredUpTo), readUpTo: later(member.readUpTo, readUpTo) }
        : member,
    ),
  }
}

// A conversation holds at most this many receipts while it waits to be described.
const MAX_EARLY_RECEIPTS = 40

// Someone taken out of a group and put back in while this client was away starts afresh:
// what it still holds from their first time there is no longer theirs to see.
const sinceJoining = (messages: LocalMessage[], joinedAfter: Position | null | undefined): LocalMessage[] => {
  if (joinedAfter == null) return messages
  const visible = (message: LocalMessage) =>
    message.id === null || comparePositions(positionOf({ id: message.id, timestamp: message.timestamp }), joinedAfter) > 0
  return messages.every(visible) ? messages : messages.filter(visible)
}

// Groups the server no longer counts the user in: they were taken out, or it was deleted,
// while this client was not connected to be told.
const withoutLostGroups = (state: ChatState, groupIds: string[] | undefined): ChatState => {
  if (groupIds === undefined) return state
  const still = new Set(groupIds)
  const lost = Object.entries(state.threads)
    .filter(([id, thread]) => thread.summary?.kind === 'group' && !still.has(id))
    .map(([id]) => id)
  return withoutThreads(state, new Set(lost))
}

// Keeps the list preview in step with messages this client has seen arrive or be
// confirmed, between the server's own updates.
const withLastMessage = (thread: Thread, message: LocalMessage): Thread => {
  if (thread.summary === null || message.id === null) return thread
  const last = thread.summary.lastMessage
  const position = positionOf({ id: message.id, timestamp: message.timestamp })
  if (last !== null && comparePositions(position, positionOf(last)) <= 0) return thread
  return {
    ...thread,
    summary: {
      ...thread.summary,
      lastMessage: {
        id: message.id,
        from: message.from,
        fromName: message.fromName,
        preview: previewOf(message.text),
        timestamp: message.timestamp,
        ...(message.attachments?.length ? { attachments: message.attachments.length } : {}),
      },
    },
  }
}

const upsertUser = <User extends { userId: string }>(users: User[], user: User) => [
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
        features: payload.features ?? NO_FEATURES,
        ownStatus: payload.ownStatus,
        loginError: null,
        loginCount: state.loginCount + 1,
        // The snapshots replace whatever was known before.
        onlineUsers: payload.onlineUsers,
        directory: payload.members ?? null,
      }
      // Conversations keep the messages already loaded; the server's summaries are laid over them.
      return payload.conversations.reduce(withSummary, withoutLostGroups(next, payload.groupIds))
    }

    case 'loginFailed':
      // Back to the form with nothing carried over: whoever logs in next may be someone else.
      return { ...initialChatState(null), loginError: action.message }

    case 'loggedOut':
      return initialChatState(null)

    case 'becameAccount':
      return { ...state, kind: 'account', admin: action.admin }

    case 'disconnected': {
      if (state.username === null) {
        // A first login was waiting for its answer when the connection went. No answer
        // will come now, so the form is given back rather than left disabled for ever.
        return state.phase === 'authenticating' ? { ...state, phase: 'loggedOut', loginError: CONNECTION_LOST } : state
      }
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

    case 'presenceChanged': {
      const { userId, status, statusText } = action.payload
      return {
        ...state,
        // Only for someone already listed: a change says nothing about who is here.
        onlineUsers: state.onlineUsers.map(user => (user.userId === userId ? { ...user, status, statusText } : user)),
      }
    }

    case 'ownStatusChanged':
      return { ...state, ownStatus: action.ownStatus }

    case 'directoryReceived':
      return { ...state, directory: action.members }

    case 'memberJoined':
      return state.directory === null ? state : { ...state, directory: upsertUser(state.directory, action.payload) }

    case 'memberLeft':
      return state.directory === null
        ? state
        : { ...state, directory: state.directory.filter(user => user.userId !== action.payload.userId) }

    case 'conversationUpdated':
      return withSummary(state, action.conversation)

    case 'conversationRemoved':
      return withoutThreads(state, new Set([action.conversationId]))

    // (The server's word on the conversation — its preview, what is unread — follows.)
    case 'messageDeleted':
      return withThread(state, action.conversationId, thread =>
        thread.messages.some(message => message.id === action.id && message.kind !== 'deleted')
          ? { ...thread, messages: thread.messages.map(message => (message.id === action.id ? asDeleted(message) : message)) }
          : thread,
      )

    case 'conversationSelected': {
      const { conversationId, peer } = action
      const selected = withThreadBegun(state, conversationId, thread => {
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
          comparePositions(positionOf(messages[0]), positionOf({ id: newestHeld.id, timestamp: newestHeld.timestamp })) > 0
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
      // What happened to a group (someone was added, it was renamed) is shown in it, but
      // is not a message to read — and the server's own word on the group came just before it.
      const system = !isSaid(message)
      // The user's own message, sent from another of their devices, is not news to them.
      const counts = !message.own && !alreadyKnown && !system
      const next = withThreadBegun(state, conversationId, thread => {
        const received = {
          ...thread,
          messages: mergeConfirmed(thread.messages, [message]),
          unread: counts && !isOnScreen(state, conversationId) ? thread.unread + 1 : thread.unread,
        }
        return system ? received : withLastMessage(received, message)
      })
      return counts ? { ...next, lastIncoming: { id, fromName, conversationId } } : next
    }

    case 'receipt': {
      return withThread(state, action.payload.conversationId, thread =>
        thread.summary === null
          // Not described yet: kept until it is.
          ? { ...thread, earlyReceipts: [...(thread.earlyReceipts ?? []), action.payload].slice(-MAX_EARLY_RECEIPTS) }
          : { ...thread, summary: withReceipt(thread.summary, action.payload) },
      )
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
        ...(action.attachments?.length ? { attachments: action.attachments } : {}),
        timestamp: action.timestamp,
        own: true,
        status: 'pending',
        arrivedAt: action.timestamp,
      }
      return withThreadBegun(state, action.conversationId, thread => ({
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
