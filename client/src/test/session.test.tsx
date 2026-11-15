import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  SESSION_KEY, connectAs, disconnect, fakeSocket, listedPeople, loggedInPayload, loginAs, messageBox,
  personButton, renderApp, serverSays, stored, user,
} from '@/test/harness'

const storeSession = (username: string, sessionToken: string) =>
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ username, sessionToken }))

describe('reconnecting', () => {
  it('logs in again with the session token, and only then allows sending', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')])
    await events.click(personButton('bob'))
    expect(messageBox('bob')).toBeEnabled()

    disconnect()
    expect(messageBox('bob')).toBeDisabled()

    connectAs('socket-2')
    expect(fakeSocket.sent('login').at(-1)).toEqual({ username: 'alice', sessionToken: 'token-1' })
    // Connected again, but not logged in yet: still no sending.
    expect(messageBox('bob')).toBeDisabled()
    expect(await screen.findByText('Signing back in as alice…')).toBeInTheDocument()

    serverSays('loggedin', loggedInPayload('alice', [user('bob', 'bob-2'), user('carol')], 'token-2'))
    expect(messageBox('bob')).toBeEnabled()
    // The new snapshot replaced the old list.
    expect(listedPeople()).toEqual(['bob', 'carol'])
  })

  it('uses the newest token on the next reconnect', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    disconnect()
    connectAs('socket-2')
    serverSays('loggedin', loggedInPayload('alice', [user('bob')], 'token-2'))

    disconnect()
    connectAs('socket-3')

    expect(fakeSocket.sent('login').at(-1)).toEqual({ username: 'alice', sessionToken: 'token-2' })
    expect(stored()).toEqual({ username: 'alice', sessionToken: 'token-2' })
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

describe('the stored session', () => {
  it('is written to sessionStorage on login, and never to localStorage', async () => {
    renderApp()

    await loginAs('alice', [user('bob')])

    expect(stored()).toEqual({ username: 'alice', sessionToken: 'token-1' })
    expect(window.localStorage.length).toBe(0)
  })

  it('logs straight back in on load, without showing the form', async () => {
    storeSession('alice', 'token-from-before')

    renderApp()

    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice', sessionToken: 'token-from-before' }])
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(screen.getByText('Signing back in as alice…')).toBeInTheDocument()

    serverSays('loggedin', loggedInPayload('alice', [user('bob')], 'token-new'))
    expect(listedPeople()).toEqual(['bob'])
    expect(stored()).toEqual({ username: 'alice', sessionToken: 'token-new' })
  })

  it('waits for the connection before logging in with a stored session', async () => {
    storeSession('alice', 'token-from-before')

    renderApp({ connected: false })
    expect(fakeSocket.sent('login')).toEqual([])

    connectAs('socket-1')
    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice', sessionToken: 'token-from-before' }])
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
    expect(fakeSocket.sent('login').at(-1)).toEqual({ username: 'alice', sessionToken: 'token-1' })
  })
})
