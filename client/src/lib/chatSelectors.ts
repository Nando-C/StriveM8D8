import { EMPTY_THREAD, type ChatState, type Thread } from '@/lib/chatState'
import { describeGroupEvent } from '@/lib/groupEvents'
import { oneLine } from '@/lib/messages'
import type { Presence } from '@/lib/status'
import type { Member, PublicUser, UserKind } from '@/types/protocol'

// What the screen shows, worked out from the chat state. Pure functions: nothing here
// is stored, so nothing here can go stale.

/** The other person in a direct conversation, as far as this client knows them. */
export interface Counterpart {
  userId: string
  username: string
  /** Their identity was removed: the chat is kept, but nothing more can be sent. */
  gone: boolean
}

/** One row of the Chats list. */
export interface ChatEntry {
  id: string
  title: string
  /** `null` for a group. */
  counterpart: Counterpart | null
  /** How the counterpart appears; `null` for a group. */
  presence: Presence | null
  /** The counterpart's own status line, possibly empty. */
  statusText: string
  /** The last message, on one line; '' if there is none to show. */
  preview: string
  /** The last message is the user's own. */
  previewOwn: boolean
  /** Groups: who wrote the last message, when it was someone else. */
  previewFrom: string | null
  /** Groups: the other members' names, for the avatar. `null` for a direct chat. */
  memberNames: string[] | null
  unread: number
  /** When the conversation was last active, for ordering. */
  activeAt: number
}

/** One row of the People list. */
export interface PersonEntry extends Member {
  presence: Presence
  statusText: string
}

const counterpartOf = (state: Pick<ChatState, 'userId'>, thread: Thread): Counterpart | null => {
  if (thread.summary !== null) {
    if (thread.summary.kind !== 'direct') return null
    const other = thread.summary.members.find(member => member.userId !== state.userId)
    if (other !== undefined) return { userId: other.userId, username: other.username, gone: other.gone === true }
  }
  if (thread.peer !== null) return { ...thread.peer, gone: false }
  // A message arrived before the server described the conversation: its author is who it is with.
  const first = thread.messages.find(message => !message.own)
  return first === undefined ? null : { userId: first.from, username: first.fromName, gone: false }
}

const titleOf = (state: Pick<ChatState, 'userId'>, thread: Thread): string =>
  thread.summary?.kind === 'group'
    ? (thread.summary.name ?? 'Group')
    : (counterpartOf(state, thread)?.username ?? 'Conversation')

/** How someone appears to this user: as the server shows them, or — if it shows nothing — offline. */
const appearanceOf = (shown: PublicUser | undefined): { presence: Presence; statusText: string } =>
  shown === undefined ? { presence: 'offline', statusText: '' } : { presence: shown.status, statusText: shown.statusText }

/** Who is shown as connected, by id: looked up once per list, not once per row. */
const shownById = (onlineUsers: PublicUser[]) => new Map(onlineUsers.map(user => [user.userId, user]))

const NO_APPEARANCE = { presence: null, statusText: '' } as const

/** The names of everyone else in a group — or, alone in it, the user's own. */
const otherNames = (state: Pick<ChatState, 'userId'>, thread: Thread): string[] => {
  const members = thread.summary?.members ?? []
  const others = members.filter(member => member.userId !== state.userId)
  return (others.length > 0 ? others : members).map(member => member.username)
}

// (Someone just added to a group is shown no message of it yet: for them it begins when they joined.)
const activeAt = (state: Pick<ChatState, 'userId'>, thread: Thread) =>
  Math.max(
    thread.summary?.lastMessage?.timestamp ?? 0,
    thread.messages.at(-1)?.timestamp ?? 0,
    thread.summary?.members.find(member => member.userId === state.userId)?.joinedAfter?.ts ?? 0,
  )

/** The user's conversations, most recently active first. One that holds nothing yet is not listed. */
export const chatList = (state: Pick<ChatState, 'threads' | 'onlineUsers' | 'userId'>): ChatEntry[] => {
  const shown = shownById(state.onlineUsers)
  return Object.entries(state.threads)
    .filter(([, thread]) => thread.summary !== null || thread.messages.length > 0)
    .map(([id, thread]) => {
      const counterpart = counterpartOf(state, thread)
      const local = thread.messages.at(-1)
      const last = thread.summary?.lastMessage ?? null
      // An unconfirmed message of the user's own is newer than anything the server has said.
      const showLocal = local !== undefined && (last === null || local.id === null || local.timestamp >= last.timestamp)
      const group = thread.summary?.kind === 'group'
      // What happened to a group is told as it is: nobody "said" it.
      const system = (showLocal ? local.kind : last?.kind) === 'system'
      const previewOwn = !system && (showLocal ? local.own : last?.from === state.userId)
      return {
        id,
        title: titleOf(state, thread),
        counterpart,
        ...(group || counterpart === null ? NO_APPEARANCE : appearanceOf(shown.get(counterpart.userId))),
        preview: system
          ? describeGroupEvent(showLocal ? local.data : last?.data, state.userId)
          : showLocal ? oneLine(local.text) : (last?.preview ?? ''),
        previewOwn,
        previewFrom: group && !system && !previewOwn ? ((showLocal ? local.fromName : last?.fromName) ?? null) : null,
        memberNames: group ? otherNames(state, thread) : null,
        unread: thread.unread,
        activeAt: activeAt(state, thread),
      }
    })
    .sort((a, b) => b.activeAt - a.activeAt || a.title.localeCompare(b.title))
}

/**
 * Everyone a chat can be started with: whoever is connected, plus — where the deployment
 * lists them — every account, connected or not. Never the user themself.
 */
export const peopleList = (state: Pick<ChatState, 'directory' | 'onlineUsers' | 'userId' | 'username'>): PersonEntry[] => {
  const shown = shownById(state.onlineUsers)
  const known = new Map<string, Member | PublicUser>()
  for (const user of state.directory ?? []) known.set(user.userId, user)
  // What is known about someone who is connected is the more recent of the two.
  for (const user of state.onlineUsers) known.set(user.userId, user)
  return [...known.values()]
    // By id once it is known; by name until then (while logging back in).
    .filter(user => (state.userId === null ? user.username !== state.username : user.userId !== state.userId))
    .map(({ userId, username, kind }) => ({ userId, username, kind, ...appearanceOf(shown.get(userId)) }))
    .sort((a, b) => a.username.localeCompare(b.username))
}

/** Someone who can be put in a group. */
export interface Candidate {
  userId: string
  username: string
  presence: Presence
  statusText: string
  /** `null` when all that is known of them is a conversation. */
  kind: UserKind | null
}

/**
 * Everyone the user could put in a group: the people list, and anyone they already have
 * a conversation with (who may not be connected, and so not be listed).
 */
export const groupCandidates = (
  state: Pick<ChatState, 'directory' | 'onlineUsers' | 'userId' | 'username' | 'threads'>,
): Candidate[] => {
  const candidates = new Map<string, Candidate>(peopleList(state).map(person => [person.userId, person]))
  for (const thread of Object.values(state.threads)) {
    const counterpart = thread.summary?.kind === 'direct' ? counterpartOf(state, thread) : null
    if (counterpart === null || counterpart.gone || candidates.has(counterpart.userId)) continue
    candidates.set(counterpart.userId, {
      userId: counterpart.userId, username: counterpart.username, presence: 'offline', statusText: '', kind: null,
    })
  }
  return [...candidates.values()].sort((a, b) => a.username.localeCompare(b.username))
}

export const totalUnread = (state: ChatState): number =>
  Object.values(state.threads).reduce((total, thread) => total + thread.unread, 0)

/** An unread count as it is written: past 99 nobody needs the number. */
export const unreadLabel = (unread: number) => (unread > 99 ? '99+' : unread)

export const selectedThread = (state: ChatState): Thread =>
  state.selected === null ? EMPTY_THREAD : (state.threads[state.selected] ?? EMPTY_THREAD)

/** What is known about a user's kind, for the small label beside their name. */
const kindOf = (state: ChatState, userId: string): UserKind | null =>
  state.onlineUsers.find(user => user.userId === userId)?.kind ??
  state.directory?.find(user => user.userId === userId)?.kind ??
  null

export interface GroupMemberEntry extends Candidate {
  admin: boolean
  /** The user themself. */
  own: boolean
}

/** What the open conversation is, when it is a group. */
export interface OpenGroup {
  name: string
  /** The user may rename it and remove people. */
  isAdmin: boolean
  /** In the order they joined. */
  members: GroupMemberEntry[]
  /** The user was added after it began: what was said before is not shown to them. */
  joinedLater: boolean
}

/** The open conversation's header. */
export interface OpenConversation {
  id: string
  title: string
  counterpart: Counterpart | null
  /** How the counterpart appears; `null` for a group. */
  presence: Presence | null
  statusText: string
  kind: UserKind | null
  /** `null` for a direct chat. */
  group: OpenGroup | null
}

const openGroup = (state: ChatState, thread: Thread): OpenGroup | null => {
  const summary = thread.summary
  if (summary === null || summary.kind !== 'group') return null
  const shown = shownById(state.onlineUsers)
  return {
    name: summary.name ?? 'Group',
    isAdmin: summary.admin === state.userId,
    members: summary.members.map(member => ({
      userId: member.userId,
      username: member.username,
      ...appearanceOf(shown.get(member.userId)),
      kind: kindOf(state, member.userId),
      admin: member.userId === summary.admin,
      own: member.userId === state.userId,
    })),
    joinedLater: summary.members.some(member => member.userId === state.userId && member.joinedAfter !== undefined),
  }
}

export const openConversation = (state: ChatState): OpenConversation | null => {
  if (state.selected === null) return null
  const thread = selectedThread(state)
  const counterpart = counterpartOf(state, thread)
  const group = thread.summary?.kind === 'group'
  return {
    id: state.selected,
    title: titleOf(state, thread),
    counterpart,
    ...(group || counterpart === null
      ? NO_APPEARANCE
      : appearanceOf(state.onlineUsers.find(user => user.userId === counterpart.userId))),
    kind: counterpart === null ? null : kindOf(state, counterpart.userId),
    group: openGroup(state, thread),
  }
}
