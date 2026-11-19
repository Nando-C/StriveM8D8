import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  chatButton, conversation, idOf, listedChats, loginAs, message, messageBox, messages, renderApp, serverSays, user,
} from '@/test/harness'
import type { ConversationSummary, GroupEvent, Message } from '@/types/protocol'

// What the client does with a group it is told about. Making and managing one from the
// interface is a later step; until then the server's events must at least be followed.

const TRIP = 'group:3f0e6c1a-0000-4000-8000-000000000001'
const mid = (n: number) => n.toString(16).padStart(24, '0')
const named = (name: string) => ({ userId: idOf(name), username: name })

const said = (n: number, from: string, text: string): Message =>
  message(from, 'alice', text, { id: mid(n), timestamp: n * 1000, conversationId: TRIP })

const happened = (n: number, data: GroupEvent): Message => ({
  id: mid(n), conversationId: TRIP, from: data.actor.userId, fromName: data.actor.username,
  kind: 'system', text: null, data, timestamp: n * 1000, clientId: null,
})

const trip = (overrides: Partial<ConversationSummary> & { last?: Message } = {}): ConversationSummary => ({
  ...conversation('alice', 'bob', overrides),
  id: TRIP,
  kind: 'group',
  name: 'Trip to Rome',
  admin: idOf('bob'),
  members: ['bob', 'alice', 'carol'].map(name => ({ ...named(name), deliveredUpTo: null, readUpTo: null })),
})

const withTheGroup = async () => {
  renderApp()
  return loginAs('alice', [user('bob')], [trip({ last: said(3, 'bob', 'shall we book?'), unreadCount: 1 })])
}

describe('a group', () => {
  it('is listed under its name, and opens like any other conversation', async () => {
    const events = await withTheGroup()

    expect(listedChats()).toEqual(['Trip to Rome'])
    expect(chatButton('Trip to Rome')).toHaveTextContent('shall we book?')
    expect(chatButton('Trip to Rome')).toHaveTextContent('1 unread message')

    await events.click(chatButton('Trip to Rome'))
    serverSays('history', { conversationId: TRIP, messages: [said(3, 'bob', 'shall we book?')], hasMore: false })
    expect(messages()).toEqual(['shall we book?'])
    expect(messageBox('Trip to Rome')).toBeEnabled()
  })

  it('appears when the user is added to one, already described before its first message', async () => {
    renderApp()
    await loginAs('alice', [user('bob')])
    expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument()

    serverSays('conversationUpdated', { conversation: trip() })
    expect(listedChats()).toEqual(['Trip to Rome'])
    expect(chatButton('Trip to Rome')).not.toHaveTextContent('unread')
  })

  it('does not count what happened to the group as something unread', async () => {
    await withTheGroup()
    const renamed: GroupEvent = { event: 'renamed', actor: named('bob'), name: 'Rome 2027' }

    // The server's word on the group comes first, then the line that records the change.
    serverSays('conversationUpdated', { conversation: { ...trip({ last: said(3, 'bob', 'shall we book?'), unreadCount: 1 }), name: 'Rome 2027' } })
    serverSays('message', happened(4, renamed))

    expect(listedChats()).toEqual(['Rome 2027'])
    expect(chatButton('Rome 2027')).toHaveTextContent('1 unread message')
    expect(document.title).toBe('(1) Strive Chat')
    // A message from a person still does.
    serverSays('message', said(5, 'carol', 'yes, let’s'))
    expect(chatButton('Rome 2027')).toHaveTextContent('2 unread messages')
    expect(chatButton('Rome 2027')).toHaveTextContent('yes, let’s')
  })

  it('is forgotten when the user is no longer in it — closed too, if it was open', async () => {
    const events = await withTheGroup()
    await events.click(chatButton('Trip to Rome'))
    serverSays('history', { conversationId: TRIP, messages: [said(3, 'bob', 'shall we book?')], hasMore: false })
    expect(screen.getByRole('log')).toBeInTheDocument()

    serverSays('conversationRemoved', { id: TRIP })

    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.queryByRole('log')).not.toBeInTheDocument())
    expect(document.title).toBe('Strive Chat')
    // One that was never known is nothing to forget.
    serverSays('conversationRemoved', { id: 'group:unknown' })
    expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument()
  })
})
