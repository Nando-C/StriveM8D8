import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  connectAs, disconnect, fakeSocket, listedPeople, loggedInPayload, loginAs, people, renderApp,
  serverSays, stored, user,
} from '@/test/harness'

describe('logging in', () => {
  it('emits login with the typed name and shows the chat once the server accepts it', async () => {
    renderApp()
    const events = userEvent.setup()

    await events.type(screen.getByLabelText('Username'), '  alice ')
    await events.click(screen.getByRole('button', { name: 'Join' }))

    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice' }])
    // Still the form while waiting for the answer.
    expect(screen.getByLabelText('Username')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()

    serverSays('loggedin', loggedInPayload('alice', [user('bob')]))

    expect(await screen.findByText('Signed in as')).toBeInTheDocument()
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(listedPeople()).toEqual(['bob'])
  })

  it('shows the server’s reason and stays on the form when the login is refused', async () => {
    renderApp()
    const events = userEvent.setup()
    await events.type(screen.getByLabelText('Username'), 'alice')
    await events.click(screen.getByRole('button', { name: 'Join' }))

    serverSays('loginError', { message: 'Username already in use' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Username already in use')
    expect(screen.getByLabelText('Username')).toBeEnabled()
    expect(screen.queryByText('Signed in as')).not.toBeInTheDocument()
    expect(stored()).toBeNull()
  })

  it('does not submit an empty name', async () => {
    renderApp()
    const events = userEvent.setup()

    await events.type(screen.getByLabelText('Username'), '   ')

    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled()
    await events.keyboard('{Enter}')
    expect(fakeSocket.sent('login')).toEqual([])
  })

  it('accepts a submit before the socket has connected', async () => {
    renderApp({ connected: false })
    const events = userEvent.setup()

    await events.type(screen.getByLabelText('Username'), 'alice{Enter}')

    // socket.io queues the login and sends it on connect; the form shows it is waiting.
    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice' }])
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
  })

  it('never uses fetch: presence comes from the socket alone', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    serverSays('newLogin', user('carol'))

    expect(listedPeople()).toEqual(['bob', 'carol'])
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('connection state', () => {
  it('reads the socket’s current state on mount, without waiting for a connect event', async () => {
    renderApp({ connected: true })
    await loginAs('alice', [user('bob')])

    // No `connect` event was ever fired in this test, yet the app knows it is connected.
    expect(screen.queryByText('Disconnected.')).not.toBeInTheDocument()
    expect(people()).toBeInTheDocument()
  })

  it('shows the disconnected notice when the connection drops and clears it when it returns', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])

    disconnect()
    expect(await screen.findByText('Disconnected.')).toBeInTheDocument()

    connectAs('socket-2')
    serverSays('loggedin', loggedInPayload('alice', [user('bob')], 'token-2'))
    await waitFor(() => expect(screen.queryByText('Disconnected.')).not.toBeInTheDocument())
    expect(screen.queryByText(/Signing back in/)).not.toBeInTheDocument()
  })
})

describe('cleaning up', () => {
  it('removes every socket listener it registered when it unmounts', async () => {
    const view = renderApp()
    await loginAs('alice', [user('bob')])
    expect(fakeSocket.listenerCount()).toBeGreaterThan(0)

    view.unmount()

    expect(fakeSocket.listenerCount()).toBe(0)
    expect(fakeSocket.off.mock.calls.length).toBe(fakeSocket.on.mock.calls.length)
  })
})
