import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fakeSocket, listedPeople, loginAs, personButton, renderApp, serverSays, user } from '@/test/harness'

describe('the people list', () => {
  it('shows everyone from the login snapshot except the user themself', async () => {
    renderApp()

    await loginAs('alice', [user('carol'), user('bob')])

    expect(listedPeople()).toEqual(['bob', 'carol'])
  })

  it('leaves the user out by name even when the snapshot holds their previous socket id', async () => {
    renderApp()

    // After a reconnect the list can briefly still carry the user's old id.
    await loginAs('alice', [user('alice', 'an-older-socket-id'), user('bob')])

    expect(listedPeople()).toEqual(['bob'])
  })

  it('adds a user who comes online', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])

    serverSays('newLogin', user('carol'))

    expect(listedPeople()).toEqual(['bob', 'carol'])
  })

  it('replaces the socket id of a user who reconnects, without a duplicate row', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob', 'bob-1')])

    serverSays('newLogin', user('bob', 'bob-2'))

    expect(listedPeople()).toEqual(['bob'])
    // The old id is gone for good: a late "left" for it must not remove bob.
    serverSays('userLeft', { id: 'bob-1' })
    expect(listedPeople()).toEqual(['bob'])
    // And the new id is the one in use.
    await events.click(personButton('bob'))
    serverSays('userLeft', { id: 'bob-2' })
    expect(personButton('bob')).toHaveTextContent('Offline')
  })

  it('never lists one socket id under two names', async () => {
    renderApp()
    await loginAs('alice', [user('bob', 'shared-id'), user('carol')])

    serverSays('newLogin', user('dave', 'shared-id'))

    // A removed entry fades out, so it is gone a moment later rather than at once.
    await waitFor(() => expect(listedPeople()).toEqual(['carol', 'dave']))
  })

  it('removes a user who leaves, and ignores a leave for an id it does not know', async () => {
    renderApp()
    await loginAs('alice', [user('bob'), user('carol')])

    serverSays('userLeft', { id: 'nobody-has-this-id' })
    expect(listedPeople()).toEqual(['bob', 'carol'])

    serverSays('userLeft', { id: 'bob-1' })
    await waitFor(() => expect(listedPeople()).toEqual(['carol']))
  })

  it('keeps a selected user in the list, marked offline, after they leave', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob'), user('carol')])
    await events.click(personButton('bob'))

    serverSays('userLeft', { id: 'bob-1' })

    expect(listedPeople()).toEqual(['carol', 'bob'])
    expect(personButton('bob')).toHaveTextContent('Offline')
    // Deselecting lets the entry go.
    await events.click(personButton('carol'))
    await waitFor(() => expect(listedPeople()).toEqual(['carol']))
    expect(fakeSocket.sent('getHistory')).toEqual([{ withUsername: 'bob' }, { withUsername: 'carol' }])
  })

  it('explains what to do when nobody else is online', async () => {
    renderApp()

    await loginAs('alice')

    expect(listedPeople()).toEqual([])
    expect(screen.getByText('Nobody else is here yet')).toBeInTheDocument()
  })
})
