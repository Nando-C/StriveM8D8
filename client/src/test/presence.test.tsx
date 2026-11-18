import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Member } from '@/types/protocol'
import { dm, fakeSocket, idOf, listedPeople, loginAs, messageBox, personButton, renderApp, serverSays, user } from '@/test/harness'

describe('the people list', () => {
  it('shows everyone from the login snapshot except the user themself, by name', async () => {
    renderApp()

    await loginAs('alice', [user('carol'), user('bob')])

    expect(listedPeople()).toEqual(['bob', 'carol'])
  })

  it('adds a user who comes online', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])

    serverSays('newLogin', user('carol'))

    expect(listedPeople()).toEqual(['bob', 'carol'])
  })

  it('keeps one row per person when they are announced again, and shows what changed', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    expect(personButton('bob')).toHaveTextContent('Guest · Online')

    // The guest became an account: the same person, announced again.
    serverSays('newLogin', user('bob', 'account'))

    expect(listedPeople()).toEqual(['bob'])
    expect(personButton('bob')).not.toHaveTextContent('Guest')
  })

  it('labels guests and the bot, and leaves accounts unmarked', async () => {
    renderApp()
    await loginAs('alice', [user('bob', 'account'), user('carol', 'guest'), user('demo-bot', 'bot')])

    expect(personButton('bob')).toHaveTextContent(/^BObobOnline$/)
    expect(personButton('carol')).toHaveTextContent('Guest · Online')
    expect(personButton('demo-bot')).toHaveTextContent('Bot · Online')
  })

  it('removes a user who leaves, and ignores a leave for someone it does not know', async () => {
    renderApp()
    await loginAs('alice', [user('bob'), user('carol')])

    serverSays('userLeft', { userId: 'nobody-has-this-id' })
    expect(listedPeople()).toEqual(['bob', 'carol'])

    serverSays('userLeft', { userId: idOf('bob') })
    // A removed entry fades out, so it is gone a moment later rather than at once.
    await waitFor(() => expect(listedPeople()).toEqual(['carol']))
  })

  it('keeps the open conversation usable after the other person leaves: they are shown as offline, not locked out', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob'), user('carol')])
    await events.click(personButton('bob'))
    expect(screen.getByRole('heading', { name: 'bob' }).parentElement).toHaveTextContent('Guest · Online')

    serverSays('userLeft', { userId: idOf('bob') })

    await waitFor(() => expect(listedPeople()).toEqual(['carol']))
    expect(screen.getByRole('heading', { name: 'bob' }).parentElement).toHaveTextContent('Offline')
    // A message can still be written: it waits for them.
    expect(messageBox('bob')).toBeEnabled()
    await events.click(personButton('carol'))
    expect(fakeSocket.sent('getHistory')).toEqual([{ conversationId: dm('alice', 'bob') }, { conversationId: dm('alice', 'carol') }])
  })

  it('explains what to do when nobody else is online', async () => {
    renderApp()

    await loginAs('alice')

    expect(listedPeople()).toEqual([])
    expect(screen.getByText('Nobody else is here yet')).toBeInTheDocument()
  })
})

describe('where every account is listed', () => {
  const member = (username: string): Member => ({ userId: idOf(username), username, kind: 'account' })
  const directory = [member('alice'), member('bea'), member('zed')]
  const login = async () => {
    renderApp()
    serverSays('loggedin', {
      userId: idOf('alice'), username: 'alice', kind: 'account', admin: false, sessionToken: 't', conversations: [],
      ownStatus: { status: 'online', statusText: '', statusClearAt: null },
      onlineUsers: [user('alice', 'account'), user('zed', 'account'), user('visitor', 'guest')],
      members: directory,
    })
    return screen.findByRole('navigation', { name: 'People' })
  }
  const names = (list: HTMLElement) => [...list.querySelectorAll('button .truncate')].map(element => element.textContent)
  const row = (list: HTMLElement, name: string) =>
    [...list.querySelectorAll('button')].find(button => button.querySelector('.truncate')?.textContent === name)!

  it('lists people who are not connected too, so a chat can be started with them', async () => {
    window.localStorage.setItem('strive-chat.account', JSON.stringify({ username: 'alice', session: 's' }))
    const list = await login()

    // Every account, plus whoever else is connected; never the user themself.
    expect(names(list)).toEqual(['bea', 'visitor', 'zed'])
    expect(row(list, 'bea')).toHaveTextContent('Offline')
    expect(row(list, 'zed')).toHaveTextContent('Online')
    expect(screen.queryByRole('navigation', { name: 'People online' })).not.toBeInTheDocument()
  })

  it('follows accounts being created and removed, and presence as before', async () => {
    window.localStorage.setItem('strive-chat.account', JSON.stringify({ username: 'alice', session: 's' }))
    const list = await login()

    serverSays('memberJoined', member('cal'))
    expect(names(list)).toEqual(['bea', 'cal', 'visitor', 'zed'])

    serverSays('memberLeft', { userId: idOf('bea') })
    serverSays('userLeft', { userId: idOf('zed') })
    await waitFor(() => expect(names(list)).toEqual(['cal', 'visitor', 'zed']))
    // Offline now, but still a member.
    expect(row(list, 'zed')).toHaveTextContent('Offline')
  })
})
