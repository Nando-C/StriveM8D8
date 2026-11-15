import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '@/App'
import { AppProviders } from '@/components/AppProviders'
import { fakeSocket } from '@/test/fakeSocket'
import type { LoggedInPayload, OnlineUser, ServerToClientEvents } from '@/types/protocol'

export { fakeSocket }

export const SESSION_KEY = 'strive-chat.session'

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

export const user = (username: string, id = `${username}-1`): OnlineUser => ({ username, id })

export const loggedInPayload = (
  username: string,
  others: OnlineUser[] = [],
  sessionToken = 'token-1',
): LoggedInPayload => ({
  username,
  id: fakeSocket.id ?? 'socket-1',
  sessionToken,
  onlineUsers: [{ username, id: fakeSocket.id ?? 'socket-1' }, ...others],
})

/** Types a name, submits, and answers as the server would on success. */
export const loginAs = async (username: string, others: OnlineUser[] = []) => {
  const events = userEvent.setup()
  await events.type(screen.getByLabelText('Username'), username)
  await events.click(screen.getByRole('button', { name: 'Join' }))
  serverSays('loggedin', loggedInPayload(username, others))
  await screen.findByRole('navigation', { name: 'People online' })
  return events
}

// ---------- reading the screen the way a user (or a screen reader) would

export const people = () => screen.getByRole('navigation', { name: 'People online' })

/** The usernames listed in the sidebar, in order. */
export const listedPeople = () =>
  within(people())
    .queryAllByRole('button')
    .map(button => button.querySelector('.truncate')?.textContent ?? '')

/** The sidebar entry for one person. */
export const personButton = (username: string) => {
  const button = within(people())
    .queryAllByRole('button')
    .find(candidate => candidate.querySelector('.truncate')?.textContent === username)
  if (button === undefined) throw new Error(`"${username}" is not in the people list`)
  return button
}

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

export const stored = (): unknown => {
  const raw = window.sessionStorage.getItem(SESSION_KEY)
  return raw === null ? null : JSON.parse(raw)
}
