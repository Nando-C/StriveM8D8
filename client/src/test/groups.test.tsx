import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { describeGroupEvent } from '@/lib/groupEvents'
import {
  chatButton, conversation, fakeSocket, idOf, listedChats, loginAs, message, messageBox, messageRow, messages,
  renderApp, serverSays, user,
} from '@/test/harness'
import type { ConversationSummary, GroupEvent, Message } from '@/types/protocol'

// Groups: what the client does with one it is told about, and the screens for making
// and managing one. The tests play the server, as everywhere else.

const answer = (event: string, response: object) => act(() => fakeSocket.last(event).ack?.(response))
const position = (n: number) => ({ ts: n * 1000, id: mid(n) })

const TRIP = 'group:3f0e6c1a-0000-4000-8000-000000000001'
function mid(n: number) {
  return n.toString(16).padStart(24, '0')
}
const named = (name: string) => ({ userId: idOf(name), username: name })

const said = (n: number, from: string, text: string): Message =>
  message(from, 'alice', text, { id: mid(n), timestamp: n * 1000, conversationId: TRIP })

const happened = (n: number, data: GroupEvent): Message => ({
  id: mid(n), conversationId: TRIP, from: data.actor.userId, fromName: data.actor.username,
  kind: 'system', text: null, data, timestamp: n * 1000, clientId: null,
})

// As the server sends a last message that is not text: with its kind and what it says happened.
const withKind = (summary: ConversationSummary, last: Message | undefined): ConversationSummary =>
  last === undefined || last.kind === 'text' || summary.lastMessage === null
    ? summary
    : { ...summary, lastMessage: { ...summary.lastMessage, kind: last.kind, data: last.data } }

const trip = (overrides: Partial<ConversationSummary> & { last?: Message } = {}): ConversationSummary => ({
  ...withKind(conversation('alice', 'bob', overrides), overrides.last),
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

describe('a group in the list', () => {
  it('says who wrote the last message, and words what last happened to it', async () => {
    await withTheGroup()
    expect(chatButton('Trip to Rome')).toHaveTextContent('bob: shall we book?')
    // A group has its own mark: two small avatars, not a person's.
    expect(chatButton('Trip to Rome').querySelector('[data-slot=group-avatar]')).not.toBeNull()

    const added: GroupEvent = { event: 'added', actor: named('bob'), targets: [named('dave'), named('erin')] }
    serverSays('conversationUpdated', { conversation: trip({ last: happened(4, added), unreadCount: 1 }) })
    expect(chatButton('Trip to Rome')).toHaveTextContent('bob added dave and erin')
    expect(chatButton('Trip to Rome')).not.toHaveTextContent('bob: bob added')

    serverSays('conversationUpdated', { conversation: trip({ last: said(5, 'alice', 'I am in'), unreadCount: 0 }) })
    expect(chatButton('Trip to Rome')).toHaveTextContent('You: I am in')
  })
})

describe('what happened to a group, in words', () => {
  const me = idOf('alice')
  it.each<[GroupEvent, string]>([
    [{ event: 'created', actor: named('bob'), name: 'Trip', targets: [named('alice')] }, 'bob created the group “Trip”'],
    [{ event: 'created', actor: named('alice'), name: 'Trip', targets: [named('bob')] }, 'You created the group “Trip”'],
    [{ event: 'added', actor: named('bob'), targets: [named('carol')] }, 'bob added carol'],
    [{ event: 'added', actor: named('alice'), targets: [named('carol'), named('dave'), named('erin')] }, 'You added carol, dave and erin'],
    [{ event: 'added', actor: named('bob'), targets: [named('alice'), named('carol')] }, 'bob added you and carol'],
    [{ event: 'removed', actor: named('bob'), target: named('carol') }, 'bob removed carol'],
    [{ event: 'left', actor: named('carol') }, 'carol left'],
    [{ event: 'left', actor: named('alice') }, 'You left'],
    [{ event: 'renamed', actor: named('bob'), name: 'Rome' }, 'bob renamed the group to “Rome”'],
  ])('%o reads “%s”', (event, expected) => {
    expect(describeGroupEvent(event, me)).toBe(expected)
  })

  it('never fails on something it does not know', () => {
    for (const data of [undefined, null, 'x', {}, { event: 'archived', actor: named('bob') }, { event: 'added', actor: named('bob') }, { event: 'removed', actor: 'bob', target: named('carol') }]) {
      expect(describeGroupEvent(data, me)).toBe('The group changed')
    }
  })
})

describe('a group conversation', () => {
  const openTheGroup = async (list: Message[], summary: Partial<ConversationSummary> = {}) => {
    renderApp()
    const events = await loginAs('alice', [user('bob')], [{ ...trip({ last: list.at(-1) }), ...summary }])
    await events.click(chatButton('Trip to Rome'))
    serverSays('history', { conversationId: TRIP, messages: list, hasMore: false })
    return events
  }
  const senders = () => [...screen.getByRole('log').querySelectorAll('[data-sender]')].map(element => element.textContent)

  it('names who wrote each run of messages, once, and shows what happened as a quiet line', async () => {
    await openTheGroup([
      happened(1, { event: 'created', actor: named('bob'), name: 'Trip to Rome', targets: [named('alice'), named('carol')] }),
      said(2, 'bob', 'shall we book?'),
      said(3, 'bob', 'flights are cheap'),
      said(4, 'carol', 'yes'),
      said(5, 'alice', 'I am in'),
      said(6, 'bob', 'done'),
    ])

    expect(messages()).toEqual(['bob created the group “Trip to Rome”', 'shall we book?', 'flights are cheap', 'yes', 'I am in', 'done'])
    // Bob's two in a row are named once; his later one, after others spoke, again.
    expect(senders()).toEqual(['bob', 'carol', 'bob'])
    // The line about the group is nobody's bubble: no time, no ticks.
    const line = screen.getByText('bob created the group “Trip to Rome”').closest('li')
    expect(line).toHaveAttribute('data-system', 'true')
    expect(line?.querySelector('time')).toBeNull()
    // Every message still says who wrote it to a screen reader.
    expect(messageRow('flights are cheap')).toHaveTextContent('bob:')
    expect(screen.getByRole('heading', { name: 'Trip to Rome' }).parentElement).toHaveTextContent('3 members: bob, you, carol')
  })

  it('draws the “new messages” line at a message, not at a change to the group', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')], [trip({ last: said(4, 'bob', 'new for alice'), unreadCount: 1 })])
    await events.click(chatButton('Trip to Rome'))
    serverSays('history', {
      conversationId: TRIP,
      messages: [said(2, 'alice', 'old'), happened(3, { event: 'renamed', actor: named('bob'), name: 'Trip to Rome' }), said(4, 'bob', 'new for alice')],
      hasMore: false,
    })

    const separator = await screen.findByRole('separator', { name: 'New messages' })
    expect(separator.nextElementSibling).toHaveTextContent('new for alice')
  })

  it('tells someone who was added later that earlier messages are not shown', async () => {
    await openTheGroup([], {
      lastMessage: null,
      members: ['bob', 'alice'].map(name => ({
        ...named(name), deliveredUpTo: null, readUpTo: null, ...(name === 'alice' ? { joinedAfter: position(9) } : {}),
      })),
    })
    expect(screen.getByText('You were added to this group here. Earlier messages are not shown.')).toBeInTheDocument()
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument()
  })

  it('says who has seen one of the user’s messages and who has only received it', async () => {
    const mine = said(5, 'alice', 'I am in')
    const events = await openTheGroup([mine], {
      members: [
        { ...named('bob'), deliveredUpTo: position(5), readUpTo: position(5) },
        { ...named('alice'), deliveredUpTo: null, readUpTo: position(5) },
        { ...named('carol'), deliveredUpTo: position(5), readUpTo: null },
        { ...named('dave'), deliveredUpTo: null, readUpTo: null },
      ],
    })
    // Not everyone has it yet: one tick, however far some have got.
    expect(messageRow('I am in')).toHaveTextContent('Sent')

    await events.click(within(messageRow('I am in')).getByRole('button', { name: /show who has seen this/ }))
    const popover = await screen.findByRole('dialog')
    expect(popover).toHaveTextContent('Seen bybob')
    expect(popover).toHaveTextContent('Delivered tocarol')
    expect(popover).not.toHaveTextContent('dave')
  })

  it('has no such list in a conversation between two people', async () => {
    renderApp()
    const events = await loginAs('alice', [user('bob')], [conversation('alice', 'bob', { last: message('alice', 'bob', 'hi', { id: mid(1), timestamp: 1000 }) })])
    await events.click(chatButton('bob'))
    serverSays('history', { conversationId: conversation('alice', 'bob').id, messages: [message('alice', 'bob', 'hi', { id: mid(1), timestamp: 1000 })], hasMore: false })
    expect(within(messageRow('hi')).queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('making a group', () => {
  const openDialog = async (others = [user('bob'), user('carol'), user('demo-bot', 'bot')], conversations: ConversationSummary[] = []) => {
    renderApp()
    const events = await loginAs('alice', others, conversations)
    await events.click(screen.getByRole('button', { name: 'New group' }))
    return { events, dialog: await screen.findByRole('dialog', { name: 'New group' }) }
  }
  const create = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Create group' })

  it('needs a name and at least one other person', async () => {
    const { events, dialog } = await openDialog()
    expect(create(dialog)).toBeDisabled()

    await events.type(within(dialog).getByLabelText('Group name'), 'Trip to Rome')
    expect(create(dialog)).toBeDisabled()
    await events.click(within(dialog).getByRole('checkbox', { name: /bob/ }))
    expect(create(dialog)).toBeEnabled()
    expect(dialog).toHaveTextContent('1 chosen')

    await events.click(within(dialog).getByRole('checkbox', { name: /bob/ }))
    expect(create(dialog)).toBeDisabled()
    expect(fakeSocket.sent('createGroup')).toHaveLength(0)
  })

  it('offers who is online and anyone the user already talks to, and finds them by name', async () => {
    const { events, dialog } = await openDialog([user('bob'), user('carol')], [conversation('alice', 'zed')])
    const offered = () => within(dialog).getAllByRole('checkbox').map(box => box.closest('label')?.textContent ?? '')

    expect(offered()).toEqual([expect.stringContaining('bob'), expect.stringContaining('carol'), expect.stringContaining('zed')])
    // Zed is not connected, and is still someone to put in a group.
    expect(offered()[2]).toContain('Offline')

    await events.type(within(dialog).getByLabelText('People'), 'CAR')
    expect(offered()).toEqual([expect.stringContaining('carol')])
    await events.clear(within(dialog).getByLabelText('People'))
    await events.type(within(dialog).getByLabelText('People'), 'nobody')
    expect(dialog).toHaveTextContent('Nobody matches “nobody”.')
  })

  it('asks the server, and opens the group once it exists', async () => {
    const { events, dialog } = await openDialog()
    await events.type(within(dialog).getByLabelText('Group name'), '  Trip to Rome ')
    await events.click(within(dialog).getByRole('checkbox', { name: /bob/ }))
    await events.click(within(dialog).getByRole('checkbox', { name: /demo-bot/ }))
    // What was chosen stays chosen while searching for someone else.
    await events.type(within(dialog).getByLabelText('People'), 'car')
    await events.click(within(dialog).getByRole('checkbox', { name: /carol/ }))
    await events.click(create(dialog))

    expect(fakeSocket.last('createGroup').payload).toEqual({
      name: 'Trip to Rome', userIds: [idOf('bob'), idOf('demo-bot'), idOf('carol')],
    })
    expect(create(dialog)).toBeDisabled()

    // The server describes the group to everyone in it, then answers.
    serverSays('conversationUpdated', { conversation: trip() })
    answer('createGroup', { ok: true, conversationId: TRIP })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(messageBox('Trip to Rome')).toBeEnabled()
    expect(chatButton('Trip to Rome')).toHaveAttribute('aria-current', 'true')
  })

  it('shows the server’s reason when it refuses, and lets the user try again', async () => {
    const { events, dialog } = await openDialog()
    await events.type(within(dialog).getByLabelText('Group name'), 'Trip')
    await events.click(within(dialog).getByRole('checkbox', { name: /bob/ }))
    await events.click(create(dialog))
    answer('createGroup', { ok: false, message: 'You have created 20 groups — leave or empty one first' })

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You have created 20 groups')
    expect(create(dialog)).toBeEnabled()
    expect(within(dialog).getByLabelText('Group name')).toHaveValue('Trip')
  })

  it('says so when there is nobody to put in one', async () => {
    const { dialog } = await openDialog([])
    expect(dialog).toHaveTextContent('There is nobody to add yet.')
    expect(create(dialog)).toBeDisabled()
  })
})

describe('a group’s details', () => {
  const openDetails = async (admin: string) => {
    renderApp()
    const events = await loginAs(
      'alice',
      [user('bob', 'guest', { status: 'away', statusText: 'packing' }), user('dave'), user('demo-bot', 'bot')],
      [{ ...trip(), admin: idOf(admin) }],
    )
    await events.click(chatButton('Trip to Rome'))
    await events.click(screen.getByRole('button', { name: 'Group details' }))
    return { events, panel: await screen.findByRole('dialog', { name: 'Trip to Rome' }) }
  }
  const memberRows = (panel: HTMLElement) =>
    within(within(panel).getByRole('region', { name: 'Members' })).getAllByRole('listitem').map(item => item.textContent)

  it('lists the members with how they appear, and who the admin is', async () => {
    const { panel } = await openDetails('bob')

    expect(panel).toHaveTextContent('3 members · bob is the admin')
    expect(memberRows(panel)).toEqual([
      expect.stringMatching(/bobAdminGuest · Away — packing$/),
      expect.stringMatching(/aliceYou$/),
      // Carol is not connected.
      expect.stringMatching(/carolOffline$/),
    ])
    // Someone who is not the admin can add people and leave — and nothing else.
    expect(within(panel).queryByLabelText('Group name')).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Add people' })).toBeEnabled()
    expect(within(panel).getByRole('button', { name: 'Leave group' })).toBeEnabled()
  })

  it('lets the admin rename the group', async () => {
    const { events, panel } = await openDetails('alice')
    expect(panel).toHaveTextContent('You are the admin')
    const field = within(panel).getByLabelText('Group name')
    const rename = within(panel).getByRole('button', { name: 'Rename' })
    expect(field).toHaveValue('Trip to Rome')
    // The name it already has is nothing to send.
    expect(rename).toBeDisabled()

    await events.clear(field)
    await events.type(field, 'Rome 2027')
    await events.click(rename)
    expect(fakeSocket.last('renameGroup').payload).toEqual({ conversationId: TRIP, name: 'Rome 2027' })

    serverSays('conversationUpdated', { conversation: { ...trip(), admin: idOf('alice'), name: 'Rome 2027' } })
    answer('renameGroup', { ok: true })
    expect(await screen.findByRole('dialog', { name: 'Rome 2027' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Rome 2027', level: 1, hidden: true })).toBeInTheDocument()
  })

  it('lets the admin remove someone, and shows the member gone when the server says so', async () => {
    const { events, panel } = await openDetails('alice')
    expect(within(panel).queryByRole('button', { name: 'Remove alice' })).not.toBeInTheDocument()

    await events.click(within(panel).getByRole('button', { name: 'Remove carol' }))
    expect(fakeSocket.last('removeMember').payload).toEqual({ conversationId: TRIP, userId: idOf('carol') })
    // Nothing is changed in advance: carol is listed until the server has done it.
    expect(memberRows(panel)).toHaveLength(3)

    const without = trip()
    serverSays('conversationUpdated', {
      conversation: { ...without, admin: idOf('alice'), members: without.members.filter(member => member.username !== 'carol') },
    })
    answer('removeMember', { ok: true })
    await waitFor(() => expect(memberRows(panel)).toHaveLength(2))
    expect(panel).toHaveTextContent('2 members')
  })

  it('shows why a change was refused', async () => {
    const { events, panel } = await openDetails('alice')
    await events.click(within(panel).getByRole('button', { name: 'Remove carol' }))
    answer('removeMember', { ok: false, message: 'The group changed in the meantime — try again' })
    expect(await within(panel).findByRole('alert')).toHaveTextContent('The group changed in the meantime')
    expect(within(panel).getByRole('button', { name: 'Remove carol' })).toBeEnabled()
  })

  it('adds people who are not in it yet', async () => {
    const { events, panel } = await openDetails('bob')
    await events.click(within(panel).getByRole('button', { name: 'Add people' }))
    const picker = within(panel).getByRole('region', { name: 'Add people' })
    const add = within(picker).getByRole('button', { name: 'Add to group' })

    // Bob is in the group already: only the others are offered.
    expect(within(picker).getAllByRole('checkbox').map(box => box.closest('label')?.textContent)).toEqual([
      expect.stringContaining('dave'), expect.stringContaining('demo-bot'),
    ])
    expect(add).toBeDisabled()
    await events.click(within(picker).getByRole('checkbox', { name: /dave/ }))
    await events.click(add)
    expect(fakeSocket.last('addMembers').payload).toEqual({ conversationId: TRIP, userIds: [idOf('dave')] })

    const bigger = trip()
    serverSays('conversationUpdated', {
      conversation: { ...bigger, members: [...bigger.members, { ...named('dave'), joinedAfter: position(9), deliveredUpTo: position(9), readUpTo: position(9) }] },
    })
    answer('addMembers', { ok: true })
    await waitFor(() => expect(memberRows(panel)).toHaveLength(4))
    expect(memberRows(panel)[3]).toMatch(/daveGuest · Online$/)

    // Back out of the picker without adding anyone.
    await events.click(within(panel).getByRole('button', { name: 'Add people' }))
    await events.click(within(panel).getByRole('button', { name: 'Back' }))
    expect(fakeSocket.sent('addMembers')).toHaveLength(1)
  })

  it('asks before leaving, and closes the conversation once the user is out', async () => {
    const { events, panel } = await openDetails('alice')
    await events.click(within(panel).getByRole('button', { name: 'Leave group' }))
    // Nothing yet: it has to be confirmed.
    expect(fakeSocket.sent('leaveGroup')).toHaveLength(0)
    expect(panel).toHaveTextContent('Leave “Trip to Rome”? You will no longer see it or its messages, and whoever has been in it longest becomes its admin.')

    await events.click(within(panel).getByRole('button', { name: 'Cancel' }))
    expect(within(panel).getByRole('region', { name: 'Members' })).toBeInTheDocument()

    await events.click(within(panel).getByRole('button', { name: 'Leave group' }))
    await events.click(within(within(panel).getByRole('region', { name: 'Leave group' })).getByRole('button', { name: 'Leave group' }))
    expect(fakeSocket.last('leaveGroup').payload).toEqual({ conversationId: TRIP })

    serverSays('conversationRemoved', { id: TRIP })
    answer('leaveGroup', { ok: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.queryByRole('log')).not.toBeInTheDocument())
    expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument()
  })

  it('closes with the conversation when the user is removed while looking at it', async () => {
    await openDetails('bob')
    serverSays('conversationRemoved', { id: TRIP })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
