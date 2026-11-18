import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SIGNED_OUT_ELSEWHERE } from '@/hooks/useChat'
import {
  RESERVATIONS_KEY, connectAs, disconnect, fakeSocket, loggedInPayload, loginAs, renderApp, reservations,
  secretFor, serverSays, stored, user,
} from '@/test/harness'
import { serverConfig } from '@/test/setup'
import type { LoggedInPayload } from '@/types/protocol'

const ACCOUNT_KEY = 'strive-chat.account'
const PASSWORD = 'correct horse battery'
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV'

const account = (): unknown => JSON.parse(window.localStorage.getItem(ACCOUNT_KEY) ?? 'null')
const storeAccount = (username: string, session: string) =>
  window.localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ username, session }))

const asAccount = (username: string, extra: Partial<LoggedInPayload> = {}): LoggedInPayload => ({
  ...loggedInPayload(username, [user('bob')]),
  kind: 'account',
  ...extra,
})

/** Answers the app's latest request for `event` as the server would. */
const answer = (event: string, response: object) => act(() => fakeSocket.last(event).ack?.(response))

const tab = (name: string) => screen.getByRole('tab', { name })
const openMenu = async (events: ReturnType<typeof userEvent.setup>, username: string) => {
  await events.click(screen.getByRole('button', { name: `Account menu for ${username}` }))
  return screen.findByRole('menu')
}
const menuItems = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map(item => item.textContent?.trim())

/** A tab that is already signed in to an account, chat on screen. */
const signedIn = async (username = 'alice', extra: Partial<LoggedInPayload> = {}) => {
  storeAccount(username, 'device-session')
  renderApp()
  serverSays('loggedin', asAccount(username, extra))
  await screen.findByRole('navigation', { name: 'People online' })
  return userEvent.setup()
}

describe('the entry screen', () => {
  it('offers guest, sign in and create account on the public demo, guest first', async () => {
    renderApp()

    expect(screen.getAllByRole('tab').map(element => element.textContent)).toEqual(['Guest', 'Sign in', 'Create account'])
    expect(tab('Guest')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument()
  })

  it('drops the guest path where the server has guests switched off', async () => {
    serverConfig.current = { signup: 'invite', guests: false, protocol: 1 }
    renderApp()

    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Guest' })).not.toBeInTheDocument())
    expect(tab('Sign in')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  it('offers only sign in where sign-up is closed and guests are off', async () => {
    serverConfig.current = { signup: 'closed', guests: false, protocol: 1 }
    renderApp()

    await waitFor(() => expect(screen.queryByRole('tablist')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('remembers what the server offered, for a visit where it is slow to answer', async () => {
    window.localStorage.setItem('strive-chat.config', JSON.stringify({ signup: 'invite', guests: false }))
    serverConfig.current = null

    renderApp()

    expect(screen.queryByRole('tab', { name: 'Guest' })).not.toBeInTheDocument()
  })

  it('assumes the public demo when the server cannot be asked and nothing is remembered', async () => {
    window.localStorage.setItem('strive-chat.config', '{"signup":"everyone"}')
    serverConfig.current = null

    renderApp()

    expect(tab('Guest')).toHaveAttribute('aria-selected', 'true')
  })
})

describe('signing in to an account', () => {
  it('sends the name and password, with a label for this device, marked up for password managers', async () => {
    renderApp()
    const events = userEvent.setup()
    await events.click(tab('Sign in'))

    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    await events.type(screen.getByLabelText('Username'), ' alice ')
    await events.type(screen.getByLabelText('Password'), PASSWORD)
    await events.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice', password: PASSWORD, deviceLabel: expect.any(String) }])
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
  })

  it('keeps the device session for every tab, and the password nowhere', async () => {
    renderApp()
    const events = userEvent.setup()
    await events.click(tab('Sign in'))
    await events.type(screen.getByLabelText('Username'), 'alice')
    await events.type(screen.getByLabelText('Password'), PASSWORD)
    await events.click(screen.getByRole('button', { name: 'Sign in' }))

    serverSays('loggedin', asAccount('alice', { session: 'device-session' }))

    expect(await screen.findByText('Signed in as')).toBeInTheDocument()
    expect(account()).toEqual({ username: 'alice', session: 'device-session' })
    expect(stored()).toEqual({ username: 'alice', sessionToken: 'token-1', kind: 'account' })
    const everything = JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }])
    expect(everything).not.toContain(PASSWORD)
    // An account has no reservation: that is a guest's way of holding a name.
    expect(reservations()).toEqual({})
  })

  it('shows why a sign-in was refused, on the sign-in form', async () => {
    renderApp()
    const events = userEvent.setup()
    await events.click(tab('Sign in'))
    await events.type(screen.getByLabelText('Username'), 'alice')
    await events.type(screen.getByLabelText('Password'), 'not the password')
    await events.click(screen.getByRole('button', { name: 'Sign in' }))

    serverSays('loginError', { message: 'Wrong username or password' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password')
    expect(tab('Sign in')).toHaveAttribute('aria-selected', 'true')
    expect(account()).toBeNull()
    // Looking at another way in is not shown the error from this one.
    await events.click(tab('Guest'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('logs back in with the device session, naming its old connection so that is replaced', async () => {
    const events = await signedIn()
    expect(fakeSocket.sent('login')).toEqual([{ session: 'device-session' }])

    disconnect()
    connectAs('socket-2')

    expect(fakeSocket.sent('login').at(-1)).toEqual({ session: 'device-session', sessionToken: 'token-1' })
    expect(events).toBeDefined()
  })

  it('opens a new tab straight into the account this browser is signed in to', async () => {
    storeAccount('alice', 'device-session')

    renderApp()

    expect(fakeSocket.sent('login')).toEqual([{ session: 'device-session' }])
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.getByText('Signing back in as alice…')).toBeInTheDocument()
  })

  it('lets a tab that is a guest stay a guest, whatever account the browser holds', async () => {
    storeAccount('alice', 'device-session')
    window.sessionStorage.setItem('strive-chat.session', JSON.stringify({ username: 'visitor', sessionToken: 't' }))
    window.localStorage.setItem(RESERVATIONS_KEY, JSON.stringify({ visitor: secretFor('visitor') }))

    renderApp()

    expect(fakeSocket.sent('login')).toEqual([{ username: 'visitor', reservation: 'secret-visitor' }])
  })

  it('forgets a device session the server no longer knows, and asks for the password', async () => {
    storeAccount('alice', 'device-session')
    renderApp()

    serverSays('loginError', { message: 'Your session has ended — sign in again', sessionEnded: true })

    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has ended — sign in again')
    expect(account()).toBeNull()
    expect(stored()).toBeNull()
  })

  it('goes back to the entry screen if another tab signed this device out while it was disconnected', async () => {
    await signedIn()
    disconnect()
    window.localStorage.removeItem(ACCOUNT_KEY)

    connectAs('socket-2')

    expect(await screen.findByRole('alert')).toHaveTextContent(SIGNED_OUT_ELSEWHERE)
    expect(fakeSocket.sent('login')).toHaveLength(1)
    expect(stored()).toBeNull()
  })

  it('forgets the device session when the server signs this device out', async () => {
    await signedIn()

    serverSays('sessionRevoked', { reason: 'Signed out from another device' })
    disconnect('io server disconnect')

    expect(await screen.findByRole('alert')).toHaveTextContent('Signed out from another device')
    expect(account()).toBeNull()
  })
})

describe('creating an account', () => {
  const fillIn = async (events: ReturnType<typeof userEvent.setup>, username: string, password = PASSWORD) => {
    await events.click(tab('Create account'))
    await events.type(screen.getByLabelText('Username'), username)
    await events.type(screen.getByLabelText('Password'), password)
  }

  it('registers, shows the recovery code once, and signs in only after it has been saved', async () => {
    renderApp()
    const events = userEvent.setup()
    await fillIn(events, 'alice')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password')

    await events.click(screen.getByRole('button', { name: 'Create account' }))
    expect(fakeSocket.sent('register')).toEqual([{ username: 'alice', password: PASSWORD, deviceLabel: expect.any(String) }])
    answer('register', { ok: true, session: 'device-session', recoveryCode: CODE, kind: 'account', admin: false })

    expect(await screen.findByRole('status', { name: 'Recovery code' })).toHaveTextContent(CODE)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(fakeSocket.sent('login')).toEqual([])

    await events.click(screen.getByRole('button', { name: 'I’ve saved it' }))

    expect(fakeSocket.sent('login')).toEqual([{ session: 'device-session' }])
    expect(account()).toEqual({ username: 'alice', session: 'device-session' })
    serverSays('loggedin', asAccount('alice'))
    expect(await screen.findByText('Signed in as')).toBeInTheDocument()
    expect(screen.queryByText(CODE)).not.toBeInTheDocument()
    expect(JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }])).not.toContain(CODE)
  })

  it('copies the recovery code on request', async () => {
    renderApp()
    const events = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await fillIn(events, 'alice')
    await events.click(screen.getByRole('button', { name: 'Create account' }))
    answer('register', { ok: true, session: 's', recoveryCode: CODE, kind: 'account', admin: false })

    await events.click(await screen.findByRole('button', { name: 'Copy' }))

    expect(writeText).toHaveBeenCalledWith(CODE)
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('does not offer to submit a password the server would refuse', async () => {
    renderApp()
    const events = userEvent.setup()

    await fillIn(events, 'alice', '1234567')
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled()

    await events.type(screen.getByLabelText('Password'), '8')
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled()
  })

  it('shows the server’s reason when registration is refused, and lets the reader try again', async () => {
    renderApp()
    const events = userEvent.setup()
    await fillIn(events, 'alice')
    await events.click(screen.getByRole('button', { name: 'Create account' }))

    answer('register', { ok: false, message: 'Username already in use' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Username already in use')
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled()
    expect(account()).toBeNull()
  })

  it('says so when the server does not answer', async () => {
    renderApp()
    const events = userEvent.setup()
    await fillIn(events, 'alice')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await events.click(screen.getByRole('button', { name: 'Create account' }))

    act(() => void vi.advanceTimersByTime(10_000))

    expect(await screen.findByRole('alert')).toHaveTextContent('No answer from the server')
  })

  it('sends the reservation when the name is one this browser holds as a guest', async () => {
    window.localStorage.setItem(RESERVATIONS_KEY, JSON.stringify({ alice: 'secret-alice' }))
    renderApp()
    const events = userEvent.setup()
    await fillIn(events, 'alice')

    await events.click(screen.getByRole('button', { name: 'Create account' }))

    expect(fakeSocket.sent('register')).toEqual([expect.objectContaining({ username: 'alice', reservation: 'secret-alice' })])
  })

  it('waits for a connection before it can be submitted', async () => {
    renderApp({ connected: false })
    const events = userEvent.setup()

    await fillIn(events, 'alice')

    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
  })

  it('opens on the sign-up form with the code filled in for someone who followed an invitation link', async () => {
    serverConfig.current = { signup: 'invite', guests: false, protocol: 1 }
    window.history.replaceState(null, '', '/?invite=the-code')
    renderApp()
    const events = userEvent.setup()

    expect(await screen.findByLabelText('Invitation code')).toHaveValue('the-code')
    await events.type(screen.getByLabelText('Username'), 'ana')
    await events.type(screen.getByLabelText('Password'), PASSWORD)
    await events.click(screen.getByRole('button', { name: 'Create account' }))

    expect(fakeSocket.sent('register')).toEqual([expect.objectContaining({ username: 'ana', invitation: 'the-code' })])
    answer('register', { ok: true, session: 's', recoveryCode: CODE, kind: 'account', admin: false })
    await screen.findByRole('status', { name: 'Recovery code' })
    // Used up: it should not stay in the address bar.
    expect(window.location.search).toBe('')
  })

  it('asks for no invitation where sign-up is open', async () => {
    renderApp()
    const events = userEvent.setup()

    await events.click(tab('Create account'))

    expect(screen.queryByLabelText('Invitation code')).not.toBeInTheDocument()
  })
})

describe('a forgotten password', () => {
  it('is replaced with the recovery code; the new code is shown, then the new password signs in', async () => {
    renderApp()
    const events = userEvent.setup()
    await events.click(tab('Sign in'))
    await events.type(screen.getByLabelText('Username'), 'alice')
    await events.click(screen.getByRole('button', { name: 'Forgot your password?' }))

    // The name typed so far is carried over.
    expect(screen.getByLabelText('Username')).toHaveValue('alice')
    await events.type(screen.getByLabelText('Recovery code'), CODE)
    await events.type(screen.getByLabelText('New password'), 'a brand new password')
    await events.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(fakeSocket.sent('resetPassword')).toEqual([{ username: 'alice', recoveryCode: CODE, newPassword: 'a brand new password' }])
    answer('resetPassword', { ok: true, recoveryCode: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' })

    expect(await screen.findByRole('status', { name: 'Recovery code' })).toHaveTextContent('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ')
    await events.click(screen.getByRole('button', { name: 'I’ve saved it' }))
    expect(fakeSocket.sent('login')).toEqual([{ username: 'alice', password: 'a brand new password', deviceLabel: expect.any(String) }])
  })

  it('shows the refusal and can be backed out of', async () => {
    renderApp()
    const events = userEvent.setup()
    await events.click(tab('Sign in'))
    await events.click(screen.getByRole('button', { name: 'Forgot your password?' }))
    await events.type(screen.getByLabelText('Username'), 'alice')
    await events.type(screen.getByLabelText('Recovery code'), 'wrong')
    await events.type(screen.getByLabelText('New password'), 'a brand new password')
    await events.click(screen.getByRole('button', { name: 'Set new password' }))

    answer('resetPassword', { ok: false, message: 'Wrong username or recovery code' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or recovery code')

    await events.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('the account menu', () => {
  it('offers a guest an account to keep the name, and a way to leave', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')])

    const menu = await openMenu(events, 'alice')

    expect(menuItems(menu)).toEqual(['Create an account to keep this name', 'Leave'])
    expect(within(menu).getByText('alice · Guest')).toBeInTheDocument()
  })

  it('offers an account its devices, password, sign out and deletion — and invitations only to administrators', async () => {
    const events = await signedIn('alice')
    expect(menuItems(await openMenu(events, 'alice')))
      .toEqual(['Devices', 'Change password', 'Sign out', 'Delete account'])
  })

  it('adds invitations for an administrator', async () => {
    const events = await signedIn('owner', { admin: true })

    const menu = await openMenu(events, 'owner')

    expect(menuItems(menu)).toEqual(['Devices', 'Change password', 'Invite someone', 'Sign out', 'Delete account'])
    expect(within(menu).getByText('owner · Account · Administrator')).toBeInTheDocument()
  })

  it('does not offer a guest an account where sign-up is closed', async () => {
    serverConfig.current = { signup: 'closed', guests: true, protocol: 1 }
    renderApp()
    const events = await loginAs('alice')
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('strive-chat.config') ?? '{}').signup).toBe('closed'))

    expect(menuItems(await openMenu(events, 'alice'))).toEqual(['Leave'])
  })

  it('offers only signing out while there is no connection to ask anything over', async () => {
    const events = await signedIn('alice')
    disconnect()

    const menu = await openMenu(events, 'alice')

    for (const name of ['Devices', 'Change password', 'Delete account']) {
      expect(within(menu).getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true')
    }
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).not.toHaveAttribute('aria-disabled')
  })
})

describe('leaving', () => {
  it('signs an account’s device out: tells the server, forgets the session, shows the entry screen', async () => {
    const events = await signedIn('alice')

    await events.click(within(await openMenu(events, 'alice')).getByRole('menuitem', { name: 'Sign out' }))

    expect(fakeSocket.sent('logout')).toEqual([{}])
    expect(await screen.findByRole('tablist')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(account()).toBeNull()
    expect(stored()).toBeNull()
    // Still connected, and ready for whoever signs in next — but not by itself.
    expect(fakeSocket.disconnect).not.toHaveBeenCalled()
    expect(fakeSocket.sent('login')).toHaveLength(1)
  })

  it('lets a guest leave and come back to the same name', async () => {
    renderApp()
    const events = await loginAs('alice')

    await events.click(within(await openMenu(events, 'alice')).getByRole('menuitem', { name: 'Leave' }))
    expect(fakeSocket.sent('logout')).toEqual([{}])
    expect(reservations()).toEqual({ alice: 'secret-alice' })

    await events.type(await screen.findByLabelText('Username'), 'alice')
    await events.click(screen.getByRole('button', { name: 'Join' }))
    expect(fakeSocket.sent('login').at(-1)).toEqual({ username: 'alice', reservation: 'secret-alice' })
  })

  it('still signs out locally when there is no connection', async () => {
    const events = await signedIn('alice')
    disconnect()

    await events.click(within(await openMenu(events, 'alice')).getByRole('menuitem', { name: 'Sign out' }))

    expect(fakeSocket.sent('logout')).toEqual([])
    expect(account()).toBeNull()
    expect(await screen.findByRole('tablist')).toBeInTheDocument()
  })
})

describe('a guest creating an account from the menu', () => {
  it('registers the name they hold, shows the recovery code, and carries on as the account', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')])
    await events.click(within(await openMenu(events, 'alice')).getByRole('menuitem', { name: /Create an account/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Create an account' })

    await events.type(within(dialog).getByLabelText('Password'), PASSWORD)
    await events.click(within(dialog).getByRole('button', { name: 'Create account' }))
    // From the guest's own connection: no reservation needs to travel.
    expect(fakeSocket.sent('register')).toEqual([{ username: 'alice', password: PASSWORD, deviceLabel: expect.any(String) }])
    answer('register', { ok: true, session: 'device-session', recoveryCode: CODE, kind: 'account', admin: false })

    expect(await within(dialog).findByRole('status', { name: 'Recovery code' })).toHaveTextContent(CODE)
    // The code cannot be dismissed by accident.
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    await events.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await events.click(within(dialog).getByRole('button', { name: 'I’ve saved it' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(account()).toEqual({ username: 'alice', session: 'device-session' })
    expect(stored()).toEqual({ username: 'alice', sessionToken: 'token-1', kind: 'account' })
    // No new login was needed, and the next reconnect is as the account.
    expect(fakeSocket.sent('login')).toHaveLength(1)
    expect(menuItems(await openMenu(events, 'alice'))).toContain('Devices')
    await events.keyboard('{Escape}')
    disconnect()
    connectAs('socket-2')
    expect(fakeSocket.sent('login').at(-1)).toEqual({ session: 'device-session', sessionToken: 'token-1' })
  })
})

describe('devices', () => {
  const sessions = [
    { id: 'one', label: 'Firefox on Linux', createdAt: Date.UTC(2026, 0, 5), lastUsedAt: Date.UTC(2026, 0, 6), current: true },
    { id: 'two', label: '', createdAt: Date.UTC(2026, 0, 2), lastUsedAt: Date.UTC(2026, 0, 3), current: false },
  ]

  it('lists them, marks this one, and signs another out on request', async () => {
    const events = await signedIn('alice')
    await events.click(within(await openMenu(events, 'alice')).getByRole('menuitem', { name: 'Devices' }))
    const dialog = await screen.findByRole('dialog', { name: 'Devices' })
    expect(within(dialog).getByRole('status')).toHaveTextContent('Loading…')
    answer('listSessions', { ok: true, sessions })

    const rows = await within(dialog).findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Firefox on Linux')
    expect(rows[0]).toHaveTextContent('This device')
    // Nobody signs out the device they are on from here: that is what "Sign out" is for.
    expect(within(rows[0]).queryByRole('button')).not.toBeInTheDocument()
    expect(rows[1]).toHaveTextContent('Unnamed device')

    await events.click(within(rows[1]).getByRole('button', { name: 'Sign out' }))
    expect(fakeSocket.sent('revokeSession')).toEqual([{ id: 'two' }])
    answer('revokeSession', { ok: true })
    await waitFor(() => expect(fakeSocket.sent('listSessions')).toHaveLength(2))
    answer('listSessions', { ok: true, sessions: sessions.slice(0, 1) })

    await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(1))
  })

  it('says why when the list cannot be loaded', async () => {
    const events = await signedIn('alice')
    await events.click(within(await openMenu(events, 'alice')).getByRole('menuitem', { name: 'Devices' }))
    const dialog = await screen.findByRole('dialog', { name: 'Devices' })

    answer('listSessions', { ok: false, message: 'Service is starting, try again', retryable: true })

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Service is starting, try again')
  })
})

describe('changing the password', () => {
  it('sends both passwords and confirms; a refusal is shown and nothing is kept', async () => {
    const events = await signedIn('alice')
    await events.click(within(await openMenu(events, 'alice')).getByRole('menuitem', { name: 'Change password' }))
    const dialog = await screen.findByRole('dialog', { name: 'Change password' })
    expect(within(dialog).getByLabelText('Current password')).toHaveAttribute('autocomplete', 'current-password')
    expect(within(dialog).getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password')

    await events.type(within(dialog).getByLabelText('Current password'), 'not the password')
    await events.type(within(dialog).getByLabelText('New password'), 'a brand new password')
    await events.click(within(dialog).getByRole('button', { name: 'Change password' }))
    expect(fakeSocket.sent('changePassword')).toEqual([{ currentPassword: 'not the password', newPassword: 'a brand new password' }])
    answer('changePassword', { ok: false, message: 'Wrong password' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Wrong password')

    await events.click(within(dialog).getByRole('button', { name: 'Change password' }))
    answer('changePassword', { ok: true })

    expect(await within(dialog).findByRole('status')).toHaveTextContent('Your password was changed')
    expect(JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }])).not.toContain('a brand new password')
    await events.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('inviting someone', () => {
  it('creates a link to this page carrying the code, lists unused invitations and revokes them', async () => {
    window.history.replaceState(null, '', '/?invite=an-old-code#somewhere')
    const events = await signedIn('owner', { admin: true })
    await events.click(within(await openMenu(events, 'owner')).getByRole('menuitem', { name: 'Invite someone' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invite someone' })
    answer('listInvitations', { ok: true, invitations: [] })

    await events.click(within(dialog).getByRole('button', { name: 'Create an invitation link' }))
    expect(fakeSocket.sent('createInvitation')).toEqual([{}])
    const invitation = { id: 'inv-1', createdAt: Date.UTC(2026, 0, 5), expiresAt: Date.UTC(2026, 0, 12) }
    answer('createInvitation', { ok: true, code: 'fresh-code', ...invitation })
    await waitFor(() => expect(fakeSocket.sent('listInvitations')).toHaveLength(2))
    answer('listInvitations', { ok: true, invitations: [invitation] })

    expect(await within(dialog).findByRole('status', { name: 'Invitation link' }))
      .toHaveTextContent(`${window.location.origin}/?invite=fresh-code`)
    const row = await within(dialog).findByRole('listitem')
    // The list never shows a code: only that an invitation exists, and until when.
    expect(row).not.toHaveTextContent('fresh-code')

    await events.click(within(row).getByRole('button', { name: 'Revoke' }))
    expect(fakeSocket.sent('revokeInvitation')).toEqual([{ id: 'inv-1' }])
    answer('revokeInvitation', { ok: true })
    await waitFor(() => expect(fakeSocket.sent('listInvitations')).toHaveLength(3))
    answer('listInvitations', { ok: true, invitations: [] })
    await waitFor(() => expect(within(dialog).queryByRole('listitem')).not.toBeInTheDocument())
  })
})

describe('deleting the account', () => {
  it('asks for the password, and returns to the entry screen as nobody once the server agrees', async () => {
    const events = await signedIn('alice')
    await events.click(within(await openMenu(events, 'alice')).getByRole('menuitem', { name: 'Delete account' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete account' })
    expect(within(dialog).getByRole('button', { name: 'Delete my account' })).toBeDisabled()

    await events.type(within(dialog).getByLabelText('Password'), 'not the password')
    await events.click(within(dialog).getByRole('button', { name: 'Delete my account' }))
    answer('deleteAccount', { ok: false, message: 'Wrong password' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Wrong password')
    expect(account()).not.toBeNull()

    await events.click(within(dialog).getByRole('button', { name: 'Delete my account' }))
    expect(fakeSocket.sent('deleteAccount')).toHaveLength(2)
    answer('deleteAccount', { ok: true })

    expect(await screen.findByRole('tablist')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(account()).toBeNull()
    expect(stored()).toBeNull()
  })
})
