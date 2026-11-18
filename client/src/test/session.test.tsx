import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  RESERVATIONS_KEY, SESSION_KEY, connectAs, disconnect, fakeSocket, listedPeople, loggedInPayload, loginAs,
  messageBox, personButton, renderApp, reservations, secretFor, serverSays, stored, user,
} from '@/test/harness'
import { LOGIN_RETRY_MS } from '@/hooks/useChat'

// A tab that was logged in before: its session, and the secret that reserves its name.
const storeSession = (username: string, sessionToken: string) => {
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ username, sessionToken }))
  window.localStorage.setItem(RESERVATIONS_KEY, JSON.stringify({ [username]: secretFor(username) }))
}

describe('reconnecting', () => {
  it('logs in again with the reservation, and only then allows sending', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')])
    await events.click(personButton('bob'))
    expect(messageBox('bob')).toBeEnabled()

    disconnect()
    expect(messageBox('bob')).toBeDisabled()

    connectAs('socket-2')
    expect(fakeSocket.sent('login').at(-1)).toEqual({ username: 'alice', reservation: 'secret-alice' })
    // Connected again, but not logged in yet: still no sending.
    expect(messageBox('bob')).toBeDisabled()
    expect(await screen.findByText('Signing back in as alice…')).toBeInTheDocument()

    serverSays('loggedin', loggedInPayload('alice', [user('bob', 'bob-2'), user('carol')], 'token-2'))
    expect(messageBox('bob')).toBeEnabled()
    // The new snapshot replaced the old list.
    expect(listedPeople()).toEqual(['bob', 'carol'])
  })

  it('keeps the newest connection token, and the same reservation, across reconnects', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    disconnect()
    connectAs('socket-2')
    serverSays('loggedin', loggedInPayload('alice', [user('bob')], 'token-2'))

    disconnect()
    connectAs('socket-3')

    // A re-login's answer carries no reservation: the one already held must not be lost.
    expect(fakeSocket.sent('login').at(-1)).toEqual({ username: 'alice', reservation: 'secret-alice' })
    expect(stored()).toEqual({ username: 'alice', sessionToken: 'token-2', kind: 'guest' })
    expect(reservations()).toEqual({ alice: 'secret-alice' })
  })

  it('logs in once per connection, even if the connect event is seen twice', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    disconnect()

    connectAs('socket-2')
    connectAs('socket-2')

    expect(fakeSocket.sent('login')).toHaveLength(2)
  })

  it('asks for the open conversation’s history again after every login', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')])
    await events.click(personButton('bob'))
    expect(fakeSocket.sent('getHistory')).toEqual([{ withUsername: 'bob' }])

    disconnect()
    connectAs('socket-2')
    expect(fakeSocket.sent('getHistory')).toHaveLength(1)
    serverSays('loggedin', loggedInPayload('alice', [user('bob')], 'token-2'))

    expect(fakeSocket.sent('getHistory')).toEqual([{ withUsername: 'bob' }, { withUsername: 'bob' }])
  })

  it('emits nothing but login while logged out: a chat picked offline loads after the next login', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob'), user('carol')])
    disconnect()
    const before = fakeSocket.emitted.length

    await events.click(personButton('carol'))
    expect(fakeSocket.emitted).toHaveLength(before)

    connectAs('socket-2')
    expect(fakeSocket.emitted.slice(before).map(entry => entry.event)).toEqual(['login'])

    serverSays('loggedin', loggedInPayload('alice', [user('bob'), user('carol')], 'token-2'))
    expect(fakeSocket.emitted.slice(before).map(entry => entry.event)).toEqual(['login', 'getHistory'])
    expect(fakeSocket.sent('getHistory').at(-1)).toEqual({ withUsername: 'carol' })
  })

  it('returns to the form, with the reason, if logging back in is refused', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    disconnect()
    connectAs('socket-2')

    serverSays('loginError', { message: 'Username already in use' })

    expect(await screen.findByLabelText('Username')).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Username already in use')
    expect(stored()).toBeNull()
    // The session is gone: a further reconnect must not try to log in by itself.
    disconnect()
    connectAs('socket-3')
    expect(fakeSocket.sent('login')).toHaveLength(2)
  })
})

describe('leaving the page', () => {
  const pageHide = () => act(() => void window.dispatchEvent(new PageTransitionEvent('pagehide')))
  const pageShow = (persisted: boolean) =>
    act(() => void window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted })))

  it('tells the server straight away, and keeps the session for a reload', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])

    pageHide()

    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1)
    expect(stored()).toEqual({ username: 'alice', sessionToken: 'token-1', kind: 'guest' })
  })

  it('does nothing when there is no connection to close', async () => {
    renderApp()
    await loginAs('alice')
    disconnect()

    pageHide()

    expect(fakeSocket.disconnect).not.toHaveBeenCalled()
  })

  it('connects and logs in again when the browser restores the page from its cache', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    pageHide()

    pageShow(true)
    expect(fakeSocket.connect).toHaveBeenCalledTimes(1)

    connectAs('socket-2')
    expect(fakeSocket.sent('login').at(-1)).toEqual({ username: 'alice', reservation: 'secret-alice' })
  })

  it('does not reconnect on an ordinary page show, or one it did not close for', async () => {
    renderApp()
    await loginAs('alice')

    pageShow(false)
    pageShow(true)

    expect(fakeSocket.connect).not.toHaveBeenCalled()
  })

  it('stays signed out after a restore if another tab had taken the session over', async () => {
    renderApp()
    await loginAs('alice')
    disconnect('io server disconnect')

    pageHide()
    pageShow(true)

    expect(fakeSocket.connect).not.toHaveBeenCalled()
  })
})

describe('the stored session', () => {
  it('is written to sessionStorage on login; only the name’s reservation goes to localStorage', async () => {
    renderApp()

    await loginAs('alice', [user('bob')])

    expect(stored()).toEqual({ username: 'alice', sessionToken: 'token-1', kind: 'guest' })
    // Beside it, only what the server said it offers — nothing that identifies anyone.
    expect(Object.keys(window.localStorage).sort()).toEqual(['strive-chat.config', RESERVATIONS_KEY])
    expect(reservations()).toEqual({ alice: 'secret-alice' })
    // The session is per tab, so another tab can be someone else.
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('logs straight back in on load, without showing the form', async () => {
    storeSession('alice', 'token-from-before')

    renderApp()

    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice', reservation: 'secret-alice' }])
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(screen.getByText('Signing back in as alice…')).toBeInTheDocument()

    serverSays('loggedin', loggedInPayload('alice', [user('bob')], 'token-new'))
    expect(listedPeople()).toEqual(['bob'])
    expect(stored()).toEqual({ username: 'alice', sessionToken: 'token-new', kind: 'guest' })
  })

  it('waits for the connection before logging in with a stored session', async () => {
    storeSession('alice', 'token-from-before')

    renderApp({ connected: false })
    expect(fakeSocket.sent('login')).toEqual([])

    connectAs('socket-1')
    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice', reservation: 'secret-alice' }])
  })

  it('is cleared, and the form shown, when the server refuses it', async () => {
    storeSession('alice', 'token-from-before')
    renderApp()

    serverSays('loginError', { message: 'Username already in use' })

    expect(await screen.findByLabelText('Username')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Username already in use')
    expect(stored()).toBeNull()
  })

  it('ignores stored data that is not a session', async () => {
    window.sessionStorage.setItem(SESSION_KEY, '{"username":42}')

    renderApp()

    expect(screen.getByLabelText('Username')).toBeInTheDocument()
    expect(fakeSocket.sent('login')).toEqual([])
  })
})

describe('being signed in from another tab', () => {
  it('says so, and does not reconnect by itself', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])

    disconnect('io server disconnect')

    expect(await screen.findByText('Signed in from another tab.')).toBeInTheDocument()
    expect(screen.queryByText('Disconnected.')).not.toBeInTheDocument()
    expect(fakeSocket.connect).not.toHaveBeenCalled()
    expect(fakeSocket.sent('login')).toHaveLength(1)
  })

  it('reconnects only when asked, then logs in again', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    disconnect('io server disconnect')

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Reconnect here' }))
    expect(fakeSocket.connect).toHaveBeenCalledOnce()

    connectAs('socket-2')
    expect(fakeSocket.sent('login').at(-1)).toEqual({ username: 'alice', reservation: 'secret-alice' })
  })
})

describe('a guest name', () => {
  it('is sent with its reservation when the same name is typed again later', async () => {
    window.localStorage.setItem(RESERVATIONS_KEY, JSON.stringify({ alice: 'secret-alice', bob: 'secret-bob' }))
    renderApp()
    const events = userEvent.setup()

    await events.type(screen.getByLabelText('Username'), 'alice')
    await events.click(screen.getByRole('button', { name: 'Join' }))

    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice', reservation: 'secret-alice' }])
  })

  it('is sent bare when this browser holds no reservation for it', async () => {
    window.localStorage.setItem(RESERVATIONS_KEY, JSON.stringify({ bob: 'secret-bob' }))
    renderApp()
    const events = userEvent.setup()

    // Names that are also properties of every object must not be mistaken for reservations.
    await events.type(screen.getByLabelText('Username'), 'constructor')
    await events.click(screen.getByRole('button', { name: 'Join' }))

    expect(fakeSocket.sent('login')).toEqual([{ username: 'constructor' }])
  })

  it('keeps its reservation when the session is refused, and adds new names beside old ones', async () => {
    window.localStorage.setItem(RESERVATIONS_KEY, JSON.stringify({ bob: 'secret-bob' }))
    renderApp()
    await loginAs('alice')
    disconnect()
    connectAs('socket-2')

    serverSays('loginError', { message: 'Username already in use' })

    expect(stored()).toBeNull()
    expect(reservations()).toEqual({ bob: 'secret-bob', alice: 'secret-alice' })
  })

  it('survives stored data that is not a set of reservations', async () => {
    window.localStorage.setItem(RESERVATIONS_KEY, '["not","an","object"]')
    renderApp()

    await loginAs('alice')

    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice' }])
    expect(reservations()).toEqual({ alice: 'secret-alice' })
  })
})

describe('a server that is not ready yet', () => {
  it('is asked again after a pause while logging back in, instead of dropping to the form', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    disconnect()
    connectAs('socket-2')
    await screen.findByText('Signing back in as alice…')
    vi.useFakeTimers()

    serverSays('loginError', { message: 'Service is starting, try again', retryable: true })

    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(screen.getByText('Signing back in as alice…')).toBeInTheDocument()
    expect(stored()).toEqual({ username: 'alice', sessionToken: 'token-1', kind: 'guest' })
    expect(fakeSocket.sent('login')).toHaveLength(2)

    act(() => void vi.advanceTimersByTime(LOGIN_RETRY_MS))
    expect(fakeSocket.sent('login')).toHaveLength(3)
    expect(fakeSocket.sent('login').at(-1)).toEqual({ username: 'alice', reservation: 'secret-alice' })

    serverSays('loggedin', loggedInPayload('alice', [user('bob'), user('carol')], 'token-2'))
    expect(listedPeople()).toEqual(['bob', 'carol'])
    act(() => void vi.advanceTimersByTime(LOGIN_RETRY_MS * 3))
    expect(fakeSocket.sent('login')).toHaveLength(3)
  })

  it('does not retry on a connection that has since dropped', async () => {
    renderApp()
    await loginAs('alice')
    disconnect()
    connectAs('socket-2')
    vi.useFakeTimers()
    serverSays('loginError', { message: 'Service is starting, try again', retryable: true })

    disconnect()
    act(() => void vi.advanceTimersByTime(LOGIN_RETRY_MS * 2))

    expect(fakeSocket.sent('login')).toHaveLength(2)
  })

  it('shows its message on the form when the login was typed in', async () => {
    renderApp()
    const events = userEvent.setup()
    await events.type(screen.getByLabelText('Username'), 'alice')
    await events.click(screen.getByRole('button', { name: 'Join' }))

    serverSays('loginError', { message: 'Service is starting, try again', retryable: true })

    expect(await screen.findByRole('alert')).toHaveTextContent('Service is starting, try again')
    expect(screen.getByLabelText('Username')).toBeEnabled()
  })
})

describe('being signed out by the server', () => {
  it('returns to the form with the reason, forgets the session, and connects again for the next login', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])

    serverSays('sessionRevoked', { reason: 'This guest name expired' })
    disconnect('io server disconnect')

    expect(await screen.findByLabelText('Username')).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveTextContent('This guest name expired')
    expect(screen.queryByText('Signed in from another tab.')).not.toBeInTheDocument()
    expect(stored()).toBeNull()
    // The server closed the connection; the form needs a new one.
    expect(fakeSocket.connect).toHaveBeenCalledOnce()
    connectAs('socket-2')
    expect(fakeSocket.sent('login')).toHaveLength(1)
  })
})
