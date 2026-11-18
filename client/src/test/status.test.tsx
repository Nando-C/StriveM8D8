import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearAfterMinutes } from '@/lib/status'
import { IDLE_AFTER_MS } from '@/lib/useIdleReporter'
import {
  chatButton, connectAs, conversation, disconnect, fakeSocket, idOf, loggedInPayload, loginAs, message,
  personButton, renderApp, serverSays, user,
} from '@/test/harness'
import type { OwnStatus } from '@/types/protocol'

const answer = (event: string, response: object) => act(() => fakeSocket.last(event).ack?.(response))
const own = (status: OwnStatus['status'], statusText = '', statusClearAt: number | null = null): OwnStatus => ({ status, statusText, statusClearAt })

const openMenu = async (events: ReturnType<typeof userEvent.setup>) => {
  await events.click(screen.getByRole('button', { name: 'Account menu for alice' }))
  return screen.findByRole('menu')
}
const mark = (element: HTMLElement) => element.querySelector('[data-presence]')?.getAttribute('data-presence')

// A tab that was logged in before comes back, and the server says what status was chosen.
const returningWith = async (ownStatus: OwnStatus) => {
  window.sessionStorage.setItem('strive-chat.session', JSON.stringify({ username: 'alice', sessionToken: 't' }))
  renderApp()
  serverSays('loggedin', { ...loggedInPayload('alice'), ownStatus })
  return screen.findByRole('button', { name: 'Account menu for alice' })
}

// The idle countdown is started when a login completes. To have it run on fake timers,
// the fake timers are switched on first and the login repeated (as after a reconnect).
const withFakeTimersFromLogin = () => {
  vi.useFakeTimers()
  disconnect()
  connectAs('socket-2')
  serverSays('loggedin', loggedInPayload('alice', [], 'token-2'))
}

describe('how other people appear', () => {
  it('shows each status in words under the name, with the person’s own line after it', async () => {
    renderApp()
    await loginAs('alice', [
      user('ana', 'account'),
      user('ben', 'account', { status: 'away' }),
      user('cal', 'guest', { status: 'dnd', statusText: 'in a meeting' }),
      user('dee', 'account', { statusText: 'at lunch' }),
    ])

    expect(personButton('ana')).toHaveTextContent(/Online$/)
    expect(personButton('ben')).toHaveTextContent(/Away$/)
    expect(personButton('cal')).toHaveTextContent('Guest · Do not disturb — in a meeting')
    expect(personButton('dee')).toHaveTextContent('Online — at lunch')
  })

  it('gives each status its own mark, not just its own colour', async () => {
    renderApp()
    await loginAs('alice', [user('ana'), user('ben', 'guest', { status: 'away' }), user('cal', 'guest', { status: 'dnd' })])

    expect(mark(personButton('ana'))).toBe('online')
    expect(mark(personButton('ben'))).toBe('away')
    expect(mark(personButton('cal'))).toBe('dnd')
    // Three different shapes: the classes that draw them differ in more than a colour name.
    const shapes = ['ana', 'ben', 'cal'].map(name =>
      personButton(name).querySelector('[data-presence]')!.className.replace(/(emerald|amber|red)-\d+/g, 'colour'))
    expect(new Set(shapes).size).toBe(3)
  })

  it('follows a change as it happens', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])

    serverSays('presence', { userId: idOf('bob'), status: 'away', statusText: 'back soon' })
    expect(personButton('bob')).toHaveTextContent('Guest · Away — back soon')
    expect(mark(personButton('bob'))).toBe('away')

    serverSays('presence', { userId: idOf('bob'), status: 'online', statusText: '' })
    expect(personButton('bob')).toHaveTextContent(/Guest · Online$/)
  })

  it('does not conjure up someone it was only told a change about', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])

    serverSays('presence', { userId: 'someone-not-listed', status: 'away', statusText: '' })

    expect(screen.getByRole('navigation', { name: 'People online' }).querySelectorAll('button')).toHaveLength(1)
  })

  it('shows it in the conversation header and, in words for screen readers, on the chat list', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob', 'guest', { status: 'dnd', statusText: 'writing' })], [
      conversation('alice', 'bob', { last: message('bob', 'alice', 'later?') }),
      conversation('alice', 'carol', { last: message('carol', 'alice', 'bye') }),
    ])

    // The line under a chat is its last message, so the mark itself carries the words.
    expect(chatButton('bob')).toHaveTextContent('Do not disturb')
    expect(chatButton('carol')).toHaveTextContent('Offline')
    expect(mark(chatButton('carol'))).toBe('offline')

    await events.click(chatButton('bob'))
    expect(screen.getByRole('heading', { name: 'bob' }).parentElement).toHaveTextContent('Guest · Do not disturb — writing')
  })

  it('treats someone who went invisible exactly like someone who left', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')], [conversation('alice', 'bob', { last: message('bob', 'alice', 'hi') })])
    await events.click(chatButton('bob'))

    // All the server sends for it is this.
    serverSays('userLeft', { userId: idOf('bob') })

    expect(screen.getByRole('heading', { name: 'bob' }).parentElement).toHaveTextContent('Offline')
    expect(mark(chatButton('bob'))).toBe('offline')
  })
})

describe('choosing a status', () => {
  it('offers the four statuses, with the current one marked, and says what each means', async () => {
    renderApp()
    const events = await loginAs('alice')

    const menu = await openMenu(events)

    const choices = within(menu).getAllByRole('menuitemradio')
    expect(choices.map(choice => choice.textContent)).toEqual([
      expect.stringMatching(/^Online/), expect.stringMatching(/^Away/),
      expect.stringMatching(/^Do not disturb/), expect.stringMatching(/^Invisible/),
    ])
    expect(choices.map(choice => choice.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false'])
    expect(choices[3]).toHaveTextContent('Shown as offline; you can still read and write')
  })

  it('asks the server, and shows the new status once it agrees', async () => {
    renderApp()
    const events = await loginAs('alice')
    await events.click(within(await openMenu(events)).getByRole('menuitemradio', { name: /^Do not disturb/ }))

    expect(fakeSocket.sent('setStatus')).toEqual([{ status: 'dnd' }])
    // Not before the server has agreed.
    expect(mark(screen.getByRole('button', { name: 'Account menu for alice' }))).toBe('online')
    answer('setStatus', { ok: true, ...own('dnd') })

    const trigger = screen.getByRole('button', { name: 'Account menu for alice' })
    await waitFor(() => expect(mark(trigger)).toBe('dnd'))
    expect(trigger).toHaveTextContent('Do not disturb')
    const again = within(await openMenu(events)).getAllByRole('menuitemradio')
    expect(again.map(choice => choice.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false'])
  })

  it('keeps the old status when the server refuses', async () => {
    renderApp()
    const events = await loginAs('alice')
    await events.click(within(await openMenu(events)).getByRole('menuitemradio', { name: /^Away/ }))

    answer('setStatus', { ok: false, message: 'Too many requests, slow down' })

    expect(mark(screen.getByRole('button', { name: 'Account menu for alice' }))).toBe('online')
  })

  it('starts from what the server says was chosen before, and follows a change made on another device', async () => {
    const trigger = await returningWith(own('away', 'on the train'))
    expect(trigger).toHaveTextContent('Away — on the train')

    serverSays('ownStatus', own('online', ''))

    expect(mark(trigger)).toBe('online')
    expect(trigger).not.toHaveTextContent('Away')
  })

  it('cannot be changed while there is no connection to ask over', async () => {
    renderApp()
    const events = await loginAs('alice')
    disconnect()

    const menu = await openMenu(events)

    for (const choice of within(menu).getAllByRole('menuitemradio')) expect(choice).toHaveAttribute('aria-disabled', 'true')
    expect(within(menu).getByRole('menuitem', { name: 'Set a status message' })).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('being invisible', () => {
  const invisible = async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')])
    await events.click(within(await openMenu(events)).getByRole('menuitemradio', { name: /^Invisible/ }))
    answer('setStatus', { ok: true, ...own('invisible') })
    await screen.findByText(/You are invisible/)
    return events
  }

  it('says so, quietly and for as long as it lasts', async () => {
    const events = await invisible()

    expect(screen.getAllByRole('status').map(element => element.textContent)).toContain('You are invisible: others see you as offline.')
    // The user's own mark is the one others see: nothing.
    expect(mark(screen.getByRole('button', { name: 'Account menu for alice' }))).toBe('offline')
    // Still there after a reconnect, where the server confirms it.
    disconnect()
    connectAs('socket-2')
    serverSays('loggedin', { ...loggedInPayload('alice', [user('bob')], 'token-2'), ownStatus: own('invisible'), onlineUsers: [user('bob')] })
    expect(screen.getByText('You are invisible: others see you as offline.')).toBeInTheDocument()

    await events.click(within(await openMenu(events)).getByRole('menuitemradio', { name: /^Online/ }))
    answer('setStatus', { ok: true, ...own('online') })
    await waitFor(() => expect(screen.queryByText(/You are invisible/)).not.toBeInTheDocument())
  })

  it('still sees everyone else, and can still write', async () => {
    const events = await invisible()

    expect(personButton('bob')).toHaveTextContent('Guest · Online')
    await events.click(personButton('bob'))
    expect(screen.getByRole('textbox', { name: 'Message bob' })).toBeEnabled()
  })
})

describe('a status message', () => {
  const openDialog = async (events: ReturnType<typeof userEvent.setup>, item = 'Set a status message') => {
    await events.click(within(await openMenu(events)).getByRole('menuitem', { name: item }))
    return screen.findByRole('dialog', { name: 'Status message' })
  }

  it('is sent with how long it should stay, and shown once the server agrees', async () => {
    renderApp()
    const events = await loginAs('alice')
    const dialog = await openDialog(events)

    await events.type(within(dialog).getByLabelText('Message'), '  at lunch ')
    expect(within(dialog).getByText('8 of 80 characters')).toBeInTheDocument()
    await events.selectOptions(within(dialog).getByLabelText('Clear after'), '1 hour')
    await events.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(fakeSocket.sent('setStatus')).toEqual([{ text: 'at lunch', clearAfterMinutes: 60 }])
    answer('setStatus', { ok: true, ...own('online', 'at lunch', Date.now() + 3_600_000) })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Account menu for alice' })).toHaveTextContent('at lunch')
  })

  it('stays until changed unless a time is chosen, and offers the five durations', async () => {
    renderApp()
    const events = await loginAs('alice')
    const dialog = await openDialog(events)

    expect(within(within(dialog).getByLabelText('Clear after')).getAllByRole('option').map(option => option.textContent))
      .toEqual(['30 minutes', '1 hour', '4 hours', 'Today', 'Don’t clear'])
    await events.type(within(dialog).getByLabelText('Message'), 'on holiday')
    await events.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(fakeSocket.sent('setStatus')).toEqual([{ text: 'on holiday', clearAfterMinutes: null }])
  })

  it('cannot be longer than the server accepts, or saved empty', async () => {
    renderApp()
    const events = await loginAs('alice')
    const dialog = await openDialog(events)
    const field = within(dialog).getByLabelText('Message')

    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(field, { target: { value: 'x'.repeat(80) } })
    expect(field).toHaveAttribute('maxlength', '80')
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
    // Nothing to remove yet.
    expect(within(dialog).queryByRole('button', { name: 'Remove message' })).not.toBeInTheDocument()
  })

  it('can be changed or removed once there is one', async () => {
    await returningWith(own('online', 'at lunch'))
    const events = userEvent.setup()
    const dialog = await openDialog(events, 'Change status message')

    expect(within(dialog).getByLabelText('Message')).toHaveValue('at lunch')
    await events.click(within(dialog).getByRole('button', { name: 'Remove message' }))

    expect(fakeSocket.sent('setStatus')).toEqual([{ text: '' }])
    answer('setStatus', { ok: true, ...own('online') })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Account menu for alice' })).not.toHaveTextContent('at lunch')
  })

  it('shows the server’s reason when it is refused, and stays open', async () => {
    renderApp()
    const events = await loginAs('alice')
    const dialog = await openDialog(events)
    await events.type(within(dialog).getByLabelText('Message'), 'hello')
    await events.click(within(dialog).getByRole('button', { name: 'Save' }))

    answer('setStatus', { ok: false, message: 'Status could not be saved' })

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Status could not be saved')
    expect(within(dialog).getByLabelText('Message')).toHaveValue('hello')
  })

  it('disappears when its time runs out, as the server says', async () => {
    const trigger = await returningWith(own('dnd', 'at lunch', Date.now() + 1000))
    expect(trigger).toHaveTextContent('Do not disturb — at lunch')

    serverSays('ownStatus', own('dnd'))

    expect(trigger).toHaveTextContent('Do not disturb')
    expect(trigger).not.toHaveTextContent('at lunch')
  })

  it('counts “today” as the minutes left until midnight, never less than one', () => {
    expect(clearAfterMinutes('today', new Date(2026, 10, 18, 22, 30, 0))).toBe(90)
    expect(clearAfterMinutes('today', new Date(2026, 10, 18, 23, 59, 59))).toBe(1)
    expect(clearAfterMinutes('today', new Date(2026, 10, 18, 0, 0, 0))).toBe(24 * 60)
    expect(clearAfterMinutes('30m')).toBe(30)
    expect(clearAfterMinutes('4h')).toBe(240)
    expect(clearAfterMinutes('never')).toBeNull()
  })
})

describe('noticing that nobody is using the page', () => {
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })
  const idleReports = () => fakeSocket.sent<{ idle: boolean }>('setIdle').map(report => report.idle)

  it('tells the server after five minutes without input, and again the moment there is some', async () => {
    renderApp()
    await loginAs('alice')
    withFakeTimersFromLogin()

    act(() => void vi.advanceTimersByTime(IDLE_AFTER_MS - 1))
    expect(idleReports()).toEqual([])
    act(() => void vi.advanceTimersByTime(1))
    expect(idleReports()).toEqual([true])

    fireEvent.keyDown(window, { key: 'a' })
    expect(idleReports()).toEqual([true, false])
    // Not repeated while they carry on.
    act(() => void vi.advanceTimersByTime(5000))
    fireEvent.pointerMove(window)
    fireEvent.pointerDown(window)
    expect(idleReports()).toEqual([true, false])
  })

  it('counts from the last input, whatever kind it was', async () => {
    renderApp()
    await loginAs('alice')
    withFakeTimersFromLogin()

    for (const input of [() => fireEvent.pointerMove(window), () => fireEvent.wheel(window), () => fireEvent.touchStart(window)]) {
      act(() => void vi.advanceTimersByTime(IDLE_AFTER_MS - 1000))
      input()
    }
    expect(idleReports()).toEqual([])

    act(() => void vi.advanceTimersByTime(IDLE_AFTER_MS))
    expect(idleReports()).toEqual([true])
  })

  it('treats looking at the page again as using it', async () => {
    renderApp()
    await loginAs('alice')
    withFakeTimersFromLogin()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    // A hidden tab gets no input: it goes idle like any other.
    act(() => void vi.advanceTimersByTime(IDLE_AFTER_MS))
    expect(idleReports()).toEqual([true])

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    act(() => void document.dispatchEvent(new Event('visibilitychange')))

    expect(idleReports()).toEqual([true, false])
  })

  it('says nothing while logged out or disconnected, and starts afresh after logging back in', async () => {
    renderApp()
    vi.useFakeTimers()
    act(() => void vi.advanceTimersByTime(IDLE_AFTER_MS * 2))
    expect(idleReports()).toEqual([])
    vi.useRealTimers()

    await loginAs('alice')
    withFakeTimersFromLogin()
    act(() => void vi.advanceTimersByTime(IDLE_AFTER_MS))
    expect(idleReports()).toEqual([true])
    disconnect()
    fireEvent.keyDown(window, { key: 'a' })
    act(() => void vi.advanceTimersByTime(IDLE_AFTER_MS * 2))
    expect(idleReports()).toEqual([true])

    // The new connection is "in use" as far as the server knows: idle has to be said again.
    connectAs('socket-3')
    serverSays('loggedin', loggedInPayload('alice', [], 'token-3'))
    act(() => void vi.advanceTimersByTime(IDLE_AFTER_MS))
    expect(idleReports()).toEqual([true, true])
  })
})
