import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_KEY, connectAs, disconnect, fakeSocket, loggedInPayload, loginAs, renderApp, serverSays, user,
} from '@/test/harness'

// On free hosting the server may be asleep when someone arrives. Until the first
// connection is made, the app says so instead of looking broken or "disconnected".

describe('before the first connection', () => {
  it('says nothing at first, then explains that the server is waking', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    renderApp({ connected: false })

    // An ordinary connection takes far less than this: no notice, no flash.
    act(() => vi.advanceTimersByTime(1_499))
    expect(screen.queryByText('Waking the server…')).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('Waking the server…')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('can take up to a minute')
    expect(screen.queryByText('Disconnected.')).not.toBeInTheDocument()
  })

  it('keeps the form usable, and signs in as soon as the server is up', async () => {
    renderApp({ connected: false })
    const events = userEvent.setup()

    await events.type(screen.getByLabelText('Username'), 'alice{Enter}')
    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice' }])
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()

    connectAs('socket-1')
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
    serverSays('loggedin', loggedInPayload('alice', [user('bob')]))

    expect(await screen.findByText('Signed in as')).toBeInTheDocument()
  })

  it('removes the notice the moment the connection is made', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    renderApp({ connected: false })
    act(() => vi.advanceTimersByTime(1_500))
    expect(screen.getByText('Waking the server…')).toBeInTheDocument()

    connectAs('socket-1')

    expect(screen.queryByText('Waking the server…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toBeEnabled()
  })

  it('does not show the notice when the page loads already connected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    renderApp({ connected: true })

    act(() => vi.advanceTimersByTime(10_000))

    expect(screen.queryByText('Waking the server…')).not.toBeInTheDocument()
  })

  it('with a stored session, says it is connecting rather than disconnected', async () => {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ username: 'alice', sessionToken: 'token-0' }))
    renderApp({ connected: false })

    expect(await screen.findByText('Connecting to the server…')).toBeInTheDocument()
    expect(screen.queryByText('Disconnected.')).not.toBeInTheDocument()

    connectAs('socket-1')
    expect(await screen.findByText('Signing back in as alice…')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Connecting to the server…')).not.toBeInTheDocument())
  })
})

describe('after a connection has been made', () => {
  it('a lost connection is reported as disconnected, not as a waking server', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])

    disconnect()

    expect(await screen.findByText('Disconnected.')).toBeInTheDocument()
    expect(screen.queryByText('Connecting to the server…')).not.toBeInTheDocument()
    expect(screen.queryByText('Waking the server…')).not.toBeInTheDocument()
  })
})
