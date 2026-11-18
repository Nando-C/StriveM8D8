// Wire protocol shared with the server (see ../../../src/sockets/ and the root README).
//
// These types are a hand-maintained copy, on purpose: the server is plain JavaScript and the
// two packages are independent, so there is no shared-types package. When the server's
// protocol changes, this file changes in the same commit.

/** The version of this protocol. Sent when connecting; the server refuses any other. */
export const PROTOCOL_VERSION = 2

/**
 * Someone as everyone else sees them. `userId` is permanent and is what everything refers
 * to; the username is only its label. Nothing here says which connection anyone is on.
 */
export interface PublicUser {
  userId: string
  username: string
  kind: UserKind
  /** What they are shown as. Never `invisible`: an invisible user is not listed at all. */
  status: ShownStatus
  /** A line of their own, possibly empty. */
  statusText: string
}

/** An entry of the member directory: an account, whether or not it is connected. */
export type Member = Pick<PublicUser, 'userId' | 'username' | 'kind'>

/** What a user can choose to show. */
export type Status = 'online' | 'away' | 'dnd' | 'invisible'
/** What others can be shown. `away` is also shown for an online user who is idle. */
export type ShownStatus = Exclude<Status, 'invisible'>

/** A user's own status: what they chose, which only they are told. */
export interface OwnStatus {
  status: Status
  statusText: string
  /** When the text clears itself, in milliseconds since the epoch; `null` if it stays. */
  statusClearAt: number | null
}

export interface SetStatusPayload {
  status?: Status
  /** At most 80 characters. '' removes it. */
  text?: string
  /** How long the text stays, 1 minute to a week; `null` for until it is changed. */
  clearAfterMinutes?: number | null
}

export interface PresencePayload {
  userId: string
  status: ShownStatus
  statusText: string
}

/** A point in a conversation: a message's timestamp and id. See lib/positions.ts. */
export interface Position {
  ts: number
  id: string
}

/** A guest holds a name with a secret kept in one browser; an account has a password. */
export type IdentityKind = 'guest' | 'account'

/** What a listed user can be: the demo bot is listed too. */
export type UserKind = IdentityKind | 'bot'

/** Every acknowledgement that is not `SendMessageAck` has this shape. */
export type Ack<Result = object> =
  | ({ ok: true } & Result)
  | {
      ok: false
      message: string
      /** Nothing was wrong with the request: the server could not deal with it right now. */
      retryable?: boolean
      /** Too many wrong guesses: how long until another attempt is accepted. */
      retryAfterMs?: number
    }

// ---------- client → server

/** As a guest: a free name is reserved to this browser; a reserved one needs its secret. */
export interface GuestLoginPayload {
  username: string
  /** The secret from the `loggedin` that first reserved this name. */
  reservation?: string
}

/** To an account, with its password. Answered with a new device `session`. */
export interface PasswordLoginPayload {
  username: string
  password: string
  /** Shown in the account's list of devices, e.g. "Firefox on Linux". */
  deviceLabel?: string
  sessionToken?: string
}

/** To an account, with the device session from an earlier sign-in or sign-up. */
export interface ResumeLoginPayload {
  session: string
  /**
   * The token from this device's previous `loggedin`, so a reconnect replaces its old
   * connection instead of counting as one more device. Proves nothing by itself.
   */
  sessionToken?: string
}

export type LoginPayload = GuestLoginPayload | PasswordLoginPayload | ResumeLoginPayload

export interface RegisterPayload {
  username: string
  password: string
  /** Turns the guest who holds this name into the account, keeping their conversations. */
  reservation?: string
  /** Required where sign-up is by invitation (see `GET /config`). */
  invitation?: string
  /** Only for a deployment's owner, registering an administrator name. */
  bootstrapCode?: string
  deviceLabel?: string
}

export type RegisterAck = Ack<{
  /** The device session: log in with it (`{ session }`), and keep it for next time. */
  session: string
  /** Shown once. The only way back into the account if the password is forgotten. */
  recoveryCode: string
  kind: 'account'
  admin: boolean
}>

export interface ResetPasswordPayload {
  username: string
  recoveryCode: string
  newPassword: string
}

/** The old recovery code is used up; this is its replacement. */
export type ResetPasswordAck = Ack<{ recoveryCode: string }>

export interface ChangePasswordPayload {
  currentPassword: string
  newPassword: string
}

export interface DeviceSession {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number
  /** The session this very connection is using. */
  current: boolean
}

export type NoPayload = Record<string, never>

export interface Invitation {
  id: string
  createdAt: number
  expiresAt: number
}

export interface SendMessagePayload {
  /** See lib/conversationId.ts for the id of a direct conversation. */
  conversationId: string
  text: string
  /** Generated by this client for each message; comes back on the message itself. */
  clientId: string
}

export type SendMessageAck =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; message: string }

export interface GetHistoryPayload {
  conversationId: string
  /** Ask for the page that ends just before this position ("load earlier messages"). */
  before?: Position
}

export interface MarkReadPayload {
  conversationId: string
  upTo: Position
}

// ---------- server → client

export interface ConversationMember {
  userId: string
  /** A copy kept with the conversation: the member's identity may no longer exist. */
  username: string
  /** Groups: this member sees only what came after it. */
  joinedAfter?: Position
  /**
   * How far they have received and read. For other members this is what they let be
   * known: while someone is invisible, theirs stands still.
   */
  deliveredUpTo: Position | null
  readUpTo: Position | null
  /** Direct chats: this person's identity was removed. Nothing more can be sent. */
  gone?: true
}

export interface LastMessage {
  id: string
  from: string
  fromName: string
  /** One line, at most 80 characters. */
  preview: string
  timestamp: number
}

/** A conversation as this user is shown it. */
export interface ConversationSummary {
  id: string
  kind: 'direct' | 'group'
  name?: string
  members: ConversationMember[]
  /** `null` if there is none, or none this user may see. */
  lastMessage: LastMessage | null
  /** Messages from others after this user's read position, up to 99. */
  unreadCount: number
}

export interface LoggedInPayload {
  userId: string
  username: string
  kind: IdentityKind
  /** Administrators can invite people where sign-up is by invitation. */
  admin: boolean
  /** Private to this client. Never sent to anyone else. */
  sessionToken: string
  /** Guests, once: the secret that reserves the name. Sent only when the name was just reserved. */
  reservation?: string
  /** Accounts, after a password login: the new device session. */
  session?: string
  /** What this user has chosen to show. */
  ownStatus: OwnStatus
  /** Everyone online who can be seen — which leaves this user out while they are invisible. */
  onlineUsers: PublicUser[]
  /** This user's conversations, most recently active first (at most 50). */
  conversations: ConversationSummary[]
  /** Only where the deployment lists every account, and only for accounts: all of them. */
  members?: Member[]
}

export interface LoginErrorPayload {
  message: string
  /** The server could not check anyone right now (it is starting up): try again shortly. */
  retryable?: boolean
  /** Too many wrong guesses: how long until another attempt is accepted. */
  retryAfterMs?: number
  /** The device session no longer exists: forget it and ask for the password. */
  sessionEnded?: boolean
}

/** This connection was signed out on purpose, and is about to be closed by the server. */
export interface SessionRevokedPayload {
  reason: string
}

export interface UserLeftPayload {
  userId: string
}

export type MessageKind = 'text' | 'system' | 'call' | 'deleted'

/** A message, live or in history: the same shape, and the same `id`, in both. */
export interface Message {
  id: string
  conversationId: string
  /** The author's `userId`. */
  from: string
  /** The author's username when the message was sent. */
  fromName: string
  kind: MessageKind
  /** `null` for kinds that carry no text. */
  text: string | null
  /** Structured content of system and call messages. */
  data?: unknown
  timestamp: number
  /** The id this client gave the message when sending it; `null` on anyone else's. */
  clientId: string | null
}

export interface HistoryPayload {
  conversationId: string
  /** Up to 100 messages, oldest first. */
  messages: Message[]
  /** Whether there are messages before the first of these. */
  hasMore: boolean
}

export interface HistoryErrorPayload {
  /** Echoed from the request, or `null` if the request did not carry a string. */
  conversationId: string | null
  message: string
}

/** Where another member of a conversation now stands — as far as others may know. */
export interface ReceiptPayload {
  conversationId: string
  userId: string
  deliveredUpTo: Position | null
  readUpTo: Position | null
}

export interface ConversationUpdatedPayload {
  conversation: ConversationSummary
}

// ---------- event maps for socket.io's typed sockets

export interface ServerToClientEvents {
  /** Acknowledge it (call `confirm`): for a newly reserved guest name, the server waits to hear that the secret arrived. */
  loggedin: (payload: LoggedInPayload, confirm?: () => void) => void
  loginError: (payload: LoginErrorPayload) => void
  sessionRevoked: (payload: SessionRevokedPayload) => void
  /** A user came online, or what is known about an online user changed: upsert by `userId`. */
  newLogin: (payload: PublicUser) => void
  userLeft: (payload: UserLeftPayload) => void
  /** How an online user is shown has changed. */
  presence: (payload: PresencePayload) => void
  /** This user's own status changed on another of their devices, or its text ran out. */
  ownStatus: (payload: OwnStatus) => void
  /** Acknowledge it (call `ack`): that is what tells the sender it was delivered to this device. */
  message: (payload: Message, ack?: () => void) => void
  /** Another member received or read up to here. */
  receipt: (payload: ReceiptPayload) => void
  /** A conversation is new to this user, or something about it changed: replace it. */
  conversationUpdated: (payload: ConversationUpdatedPayload) => void
  /** Member directory only: an account was created / removed. */
  memberJoined: (payload: Member) => void
  /** The whole directory: sent to a guest at the moment they become an account. */
  memberDirectory: (payload: { members: Member[] }) => void
  memberLeft: (payload: UserLeftPayload) => void
  history: (payload: HistoryPayload) => void
  historyError: (payload: HistoryErrorPayload) => void
}

export interface ClientToServerEvents {
  login: (payload: LoginPayload) => void
  sendmessage: (payload: SendMessagePayload, ack: (response: SendMessageAck) => void) => void
  getHistory: (payload: GetHistoryPayload) => void
  setStatus: (payload: SetStatusPayload, ack: (response: Ack<OwnStatus>) => void) => void
  /** Nobody has used this page for a while / somebody is using it again. */
  setIdle: (payload: { idle: boolean }, ack: (response: Ack) => void) => void
  /** "I have read this conversation up to here." */
  markRead: (payload: MarkReadPayload, ack: (response: Ack) => void) => void
  register: (payload: RegisterPayload, ack: (response: RegisterAck) => void) => void
  resetPassword: (payload: ResetPasswordPayload, ack: (response: ResetPasswordAck) => void) => void
  changePassword: (payload: ChangePasswordPayload, ack: (response: Ack) => void) => void
  deleteAccount: (payload: { password: string }, ack: (response: Ack) => void) => void
  // The requests below that need no data still send an (empty) object, so that every
  // request has the same shape: a payload, then the acknowledgement.
  listSessions: (payload: NoPayload, ack: (response: Ack<{ sessions: DeviceSession[] }>) => void) => void
  revokeSession: (payload: { id: string }, ack: (response: Ack) => void) => void
  logout: (payload: NoPayload, ack: (response: Ack) => void) => void
  /** Administrators only. The code is returned this once. */
  createInvitation: (payload: NoPayload, ack: (response: Ack<Invitation & { code: string }>) => void) => void
  listInvitations: (payload: NoPayload, ack: (response: Ack<{ invitations: Invitation[] }>) => void) => void
  revokeInvitation: (payload: { id: string }, ack: (response: Ack) => void) => void
}
