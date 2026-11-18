import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '@/App'
import { AppProviders } from '@/components/AppProviders'
import { fakeSocket } from '@/test/fakeSocket'
import { directConversationId } from '@/lib/conversationId'
import type {
  ConversationSummary, LoggedInPayload, Message, PublicUser, ServerToClientEvents, UserKind,
} from '@/types/protocol'

export { fakeSocket }

export const SESSION_KEY = 'strive-chat.session'
export const RESERVATIONS_KEY = 'strive-chat.reservations'

interface RenderOptions {
  /** Whether the socket is already connected when the app mounts. Default: yes. */
  connected?: boolean
}

export const renderApp = ({ connected = true }: RenderOptions = {}) => {
  if (connected) {
    fakeSocket.connected = true
    fakeSocket.id = 'socket-1'
  }
  return render(
    <AppProviders>
      <App />
    </AppProviders>,
  )
}

/** Deliver a server event to the app, typed against the real protocol. */
export const serverSays = <Event extends keyof ServerToClientEvents>(
  event: Event,
  ...args: Parameters<ServerToClientEvents[Event]>
) => act(() => fakeSocket.trigger(event, ...args))

export const connectAs = (id: string) => act(() => fakeSocket.simulateConnect(id))
export const disconnect = (reason?: string) => act(() => fakeSocket.simulateDisconnect(reason))

/** The permanent id the fake server gives `username`. */
export const idOf = (username: string) => `${username}-id`

export const user = (username: string, kind: UserKind = 'guest'): PublicUser => ({ userId: idOf(username), username, kind })

/** The id of the direct conversation between two users, by name. */
export const dm = (a: string, b: string) => directConversationId(idOf(a), idOf(b))

export const loggedInPayload = (
  username: string,
  others: PublicUser[] = [],
  sessionToken = 'token-1',
  /** Only on the login that first reserves the name, as the server sends it. */
  reservation?: string,
  conversations: ConversationSummary[] = [],
): LoggedInPayload => ({
  userId: idOf(username),
  username,
  kind: 'guest',
  admin: false,
  sessionToken,
  ...(reservation === undefined ? {} : { reservation }),
  onlineUsers: [user(username), ...others],
  conversations,
})

let nextMessageId = 0
/** A fresh, valid message id (24 hex digits), increasing so that later ones sort later. */
export const messageId = () => (++nextMessageId).toString(16).padStart(24, '0')

/** A message as the server sends it, in the direct conversation between `from` and `to`. */
export const message = (from: string, to: string, text: string, overrides: Partial<Message> = {}): Message => ({
  id: messageId(),
  conversationId: dm(from, to),
  from: idOf(from),
  fromName: from,
  kind: 'text',
  text,
  timestamp: Date.now(),
  clientId: null,
  ...overrides,
})

/** The direct conversation between `self` and `other`, as the server describes it to `self`. */
export const conversation = (
  self: string,
  other: string,
  overrides: Partial<ConversationSummary> & { last?: Message } = {},
): ConversationSummary => {
  const { last, ...rest } = overrides
  return {
    id: dm(self, other),
    kind: 'direct',
    members: [self, other].map(name => ({ userId: idOf(name), username: name, deliveredUpTo: null, readUpTo: null })),
    lastMessage: last === undefined
      ? null
      : { id: last.id, from: last.from, fromName: last.fromName, preview: last.text ?? '', timestamp: last.timestamp },
    unreadCount: 0,
    ...rest,
  }
}

/** The secret the fake server hands out when `username` is first reserved. */
export const secretFor = (username: string) => `secret-${username}`

/** Types a name, submits, and answers as the server would on success. */
export const loginAs = async (username: string, others: PublicUser[] = [], conversations: ConversationSummary[] = []) => {
  const events = userEvent.setup()
  await events.type(screen.getByLabelText('Username'), username)
  await events.click(screen.getByRole('button', { name: 'Join' }))
  serverSays('loggedin', loggedInPayload(username, others, 'token-1', secretFor(username), conversations))
  await screen.findByRole('navigation', { name: 'People online' })
  return events
}

// ---------- reading the screen the way a user (or a screen reader) would

export const people = () => screen.getByRole('navigation', { name: 'People online' })
export const chats = () => screen.queryByRole('navigation', { name: 'Chats' })

const namesIn = (list: HTMLElement | null) =>
  list === null
    ? []
    : within(list)
        .queryAllByRole('button')
        .map(button => button.querySelector('.truncate')?.textContent ?? '')

const buttonIn = (list: HTMLElement | null, name: string, what: string) => {
  const button = list === null
    ? undefined
    : within(list).queryAllByRole('button').find(candidate => candidate.querySelector('.truncate')?.textContent === name)
  if (button === undefined) throw new Error(`"${name}" is not in the ${what} list`)
  return button
}

/** The usernames listed under People, in order. */
export const listedPeople = () => namesIn(people())
/** The conversations listed under Chats, in order. */
export const listedChats = () => namesIn(chats())

/** The People entry for one person: clicking it opens the chat with them. */
export const personButton = (username: string) => buttonIn(people(), username, 'people')
/** The Chats entry for one conversation. */
export const chatButton = (title: string) => buttonIn(chats(), title, 'chats')

export const messageBox = (recipient: string) => screen.getByRole('textbox', { name: `Message ${recipient}` })
export const sendButton = () => screen.getByRole('button', { name: 'Send' })

/** The text of each message bubble in the open conversation, in order. */
export const messages = () =>
  within(screen.getByRole('log'))
    .queryAllByRole('listitem')
    .map(item => item.querySelector('p')?.textContent ?? '')

/** The full text (sender, body, status) of the message containing `text`. */
export const messageRow = (text: string) => {
  const row = within(screen.getByRole('log'))
    .getAllByRole('listitem')
    .find(item => item.querySelector('p')?.textContent === text)
  if (row === undefined) throw new Error(`no message "${text}" on screen`)
  return row
}

/** The guest reservations this browser holds, as `username → secret`. */
export const reservations = (): unknown => {
  const raw = window.localStorage.getItem(RESERVATIONS_KEY)
  return raw === null ? {} : JSON.parse(raw)
}

export const stored = (): unknown => {
  const raw = window.sessionStorage.getItem(SESSION_KEY)
  return raw === null ? null : JSON.parse(raw)
}
