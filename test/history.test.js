import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { conversationsFor } from '../src/conversations.js'
import { Conversation } from '../src/models/conversation.js'
import { Message } from '../src/models/message.js'
import {
    connectTestDatabase, disconnectTestDatabase, dm, getHistory, join, login, markRead, messageTo, nextEvent,
    onlineUsers, positionOf, record, send, settle, sortedKeys, startApp,
} from './helpers.js'

let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
beforeEach(async () => {
    app = await startApp()
})
afterEach(() => app.stop())

const twoUsers = async () => ({ alice: await join(app, 'alice'), bob: await join(app, 'bob') })

// Puts `count` messages straight into the conversation between the two, alternating authors.
const seed = async (alice, bob, count, createdAt) => {
    const id = dm(alice, bob)
    await Conversation.updateOne(
        { _id: id },
        { $setOnInsert: { kind: 'direct', members: [alice, bob].map(({ userId, username }) => ({ userId, username })) } },
        { upsert: true },
    )
    return Message.insertMany(
        Array.from({ length: count }, (_unused, index) => ({
            conversationKey: id,
            from: index % 2 ? bob.userId : alice.userId,
            fromName: index % 2 ? 'bob' : 'alice',
            text: `message ${index}`,
            createdAt: createdAt(index),
        })),
    )
}

const UNKNOWN = 'Unknown conversation'

describe('history', () => {
    it('returns the conversation after one side reconnects', async () => {
        const { alice, bob } = await twoUsers()
        const id = dm(alice, bob)
        const first = messageTo(id, 'one')
        const second = messageTo(id, 'two')
        const third = messageTo(id, 'three')

        const liveFirst = nextEvent(bob.socket, 'message')
        const firstAck = await send(alice.socket, first)
        const live = await liveFirst
        const secondAck = await send(bob.socket, second)
        const thirdAck = await send(alice.socket, third)

        bob.socket.close()
        await expect.poll(async () => (await onlineUsers(app)).length).toBe(1)
        const bobAgain = await app.client()
        await login(bobAgain, { username: 'bob', reservation: bob.reservation })

        const history = await getHistory(bobAgain, { conversationId: id })

        expect(history).toMatchObject({ ok: true, conversationId: id, hasMore: false })
        expect(history.messages.map(message => message.text)).toEqual(['one', 'two', 'three'])
        expect(history.messages.map(message => message.id)).toEqual([firstAck.id, secondAck.id, thirdAck.id])
        // Each reader gets back only the client ids of their own messages.
        expect(history.messages.map(message => message.clientId)).toEqual([null, second.clientId, null])
        // A message is the same object live and in history.
        expect(history.messages[0]).toEqual(live)
        const forAlice = await getHistory(alice.socket, { conversationId: id })
        expect(forAlice.messages.map(message => message.clientId)).toEqual([first.clientId, null, third.clientId])
    })

    it('gives both sides the same conversation and keeps other conversations out of it', async () => {
        const { alice, bob } = await twoUsers()
        const carol = await join(app, 'carol')
        await send(alice.socket, messageTo(dm(alice, bob), 'for bob'))
        await send(alice.socket, messageTo(dm(alice, carol), 'for carol'))

        const fromAlice = await getHistory(alice.socket, { conversationId: dm(alice, bob) })
        const fromBob = await getHistory(bob.socket, { conversationId: dm(alice, bob) })
        const bobAndCarol = await getHistory(bob.socket, { conversationId: dm(bob, carol) })

        expect(fromAlice.messages.map(message => message.text)).toEqual(['for bob'])
        expect(fromBob.messages.map(message => message.id)).toEqual(fromAlice.messages.map(message => message.id))
        // Nothing said yet between these two: empty, not an error, and nothing is created by asking.
        expect(bobAndCarol).toEqual({ ok: true, conversationId: dm(bob, carol), messages: [], hasMore: false })
        expect(await Conversation.countDocuments()).toBe(2)
    })

    it('uses exactly the documented message shape, with null for a missing client id', async () => {
        const { alice, bob } = await twoUsers()
        await seed(alice, bob, 1, () => new Date())

        const history = await getHistory(alice.socket, { conversationId: dm(alice, bob) })

        expect(sortedKeys(history.messages[0]))
            .toEqual(['clientId', 'conversationId', 'from', 'fromName', 'id', 'kind', 'text', 'timestamp'])
        expect(history.messages[0]).toMatchObject({ from: alice.userId, fromName: 'alice', kind: 'text', clientId: null })
        expect(history.messages[0].id).toEqual(expect.any(String))
        expect(history.messages[0].timestamp).toEqual(expect.any(Number))
    })

    it('refuses a request from a socket that has not logged in', async () => {
        const { alice, bob } = await twoUsers()
        const stranger = await app.client()

        expect(await getHistory(stranger, { conversationId: dm(alice, bob) }))
            .toEqual({ ok: false, conversationId: dm(alice, bob), message: 'Not logged in' })
    })

    it('refuses a malformed request and echoes the conversation back', async () => {
        const { alice, bob } = await twoUsers()

        expect(await getHistory(alice.socket, { conversationId: 42 }))
            .toEqual({ ok: false, conversationId: null, message: 'Invalid conversation' })
        for (const before of ['yesterday', { ts: 'x', id: 'y' }, { ts: 1 }, { ts: 1, id: { $gt: '' } }, 12345]) {
            expect(await getHistory(alice.socket, { conversationId: dm(alice, bob), before }))
                .toEqual({ ok: false, conversationId: dm(alice, bob), message: 'Invalid position' })
        }
    })
})

describe('who may read a conversation', () => {
    it('is nobody but its members, whatever id is asked for', async () => {
        const { alice, bob } = await twoUsers()
        const carol = await join(app, 'carol')
        await send(alice.socket, messageTo(dm(alice, bob), 'private'))

        for (const conversationId of [dm(alice, bob), 'no-such-conversation', 'group:made-up', dm(alice, 'someone-else')]) {
            expect(await getHistory(carol.socket, { conversationId }))
                .toEqual({ ok: false, conversationId, message: UNKNOWN })
        }
    })

    it('is decided by the stored members, not by what the id says', async () => {
        const { alice, bob } = await twoUsers()
        const carol = await join(app, 'carol')
        await seed(bob, carol, 2, () => new Date())
        // The same conversation, filed under an id that names alice.
        await Conversation.create({
            _id: dm(alice, bob), kind: 'direct',
            members: [{ userId: bob.userId, username: 'bob' }, { userId: carol.userId, username: 'carol' }],
        })
        await Message.create({ conversationKey: dm(alice, bob), from: bob.userId, fromName: 'bob', text: 'not for alice' })

        expect(await getHistory(alice.socket, { conversationId: dm(alice, bob) }))
            .toEqual({ ok: false, conversationId: dm(alice, bob), message: UNKNOWN })
        expect((await getHistory(carol.socket, { conversationId: dm(alice, bob) })).messages).toHaveLength(1)
    })

    it('does not pass to whoever takes the name of a member who is gone', async () => {
        const { alice, bob } = await twoUsers()
        await send(alice.socket, messageTo(dm(alice, bob), 'for the first bob'))
        bob.socket.close()
        await expect.poll(async () => (await onlineUsers(app)).length).toBe(1)
        const told = nextEvent(alice.socket, 'conversationUpdated')
        expect(await app.runMaintenance({ now: Date.now() + 31 * 24 * 3600_000 })).toEqual({ removedGuests: 1 })

        // Alice keeps the conversation, sees whose it was, and is told he is gone.
        const { conversation } = await told
        expect(conversation.members.find(member => member.userId === bob.userId)).toMatchObject({ username: 'bob', gone: true })
        expect(await send(alice.socket, messageTo(dm(alice, bob), 'anyone?')))
            .toEqual({ ok: false, message: 'This person is no longer here' })
        const kept = await getHistory(alice.socket, { conversationId: dm(alice, bob) })
        expect(kept.messages.map(message => [message.fromName, message.text])).toEqual([['alice', 'for the first bob']])

        // Someone new takes the name: a different identity, with none of this.
        const newBob = await join(app, 'bob')
        expect(newBob.userId).not.toBe(bob.userId)
        expect(newBob.conversations).toEqual([])
        expect(await getHistory(newBob.socket, { conversationId: dm(alice, bob) }))
            .toEqual({ ok: false, conversationId: dm(alice, bob), message: UNKNOWN })
        expect(await send(newBob.socket, messageTo(dm(alice, bob)))).toEqual({ ok: false, message: UNKNOWN })
        // Between alice and the new bob it is a fresh, empty conversation.
        expect((await getHistory(newBob.socket, { conversationId: dm(alice, newBob) })).messages).toEqual([])
    })

    it('shows a member only what came after they joined — in history, the unread count and the preview', async () => {
        const { alice, bob } = await twoUsers()
        const start = Date.now() - 100_000
        const seeded = await seed(alice, bob, 6, index => new Date(start + index * 1000))
        // As a group would record it: bob joined after the fourth message.
        const joinedAfter = { ts: seeded[3].createdAt.getTime(), id: seeded[3]._id.toString() }
        const last = seeded[5]
        await Conversation.updateOne(
            { _id: dm(alice, bob), 'members.userId': bob.userId },
            { $set: { 'members.$.joinedAfter': joinedAfter, lastMessage: { id: last._id.toString(), from: last.from, fromName: 'bob', preview: 'message 5', timestamp: last.createdAt.getTime() } } },
        )

        const history = await getHistory(bob.socket, { conversationId: dm(alice, bob) })
        expect(history.messages.map(message => message.text)).toEqual(['message 4', 'message 5'])
        expect(history.hasMore).toBe(false)
        // Paging backwards does not get behind the boundary either.
        const earlier = await getHistory(bob.socket, { conversationId: dm(alice, bob), before: positionOf(history.messages[0]) })
        expect(earlier.messages).toEqual([])

        const again = await app.client()
        const session = await login(again, { username: 'bob', reservation: bob.reservation })
        // Of the two he can see, only "message 4" is from someone else.
        expect(session.conversations[0].unreadCount).toBe(1)
        expect(session.conversations[0].members.find(member => member.userId === bob.userId).joinedAfter).toEqual(joinedAfter)

        // And a preview from before he joined is not shown to him at all.
        await Conversation.updateOne({ _id: dm(alice, bob) }, { $set: { 'lastMessage.id': seeded[2]._id.toString(), 'lastMessage.timestamp': seeded[2].createdAt.getTime() } })
        const third = await app.client()
        expect((await login(third, { username: 'bob', reservation: bob.reservation })).conversations[0].lastMessage).toBeNull()
        const forAlice = await app.client()
        expect((await login(forAlice, { username: 'alice', reservation: alice.reservation })).conversations[0].lastMessage).not.toBeNull()
    })
})

describe('pages of history', () => {
    it('returns the most recent 100, oldest first, and earlier pages on request', async () => {
        const { alice, bob } = await twoUsers()
        const start = Date.now() - 1_000_000
        await seed(alice, bob, 230, index => new Date(start + index * 1000))
        const id = dm(alice, bob)

        const latest = await getHistory(alice.socket, { conversationId: id })
        expect(latest.messages).toHaveLength(100)
        expect(latest.messages[0].text).toBe('message 130')
        expect(latest.messages.at(-1).text).toBe('message 229')
        expect(latest.hasMore).toBe(true)

        const middle = await getHistory(alice.socket, { conversationId: id, before: positionOf(latest.messages[0]) })
        expect(middle.messages).toHaveLength(100)
        expect(middle.messages[0].text).toBe('message 30')
        expect(middle.messages.at(-1).text).toBe('message 129')
        expect(middle.hasMore).toBe(true)

        const oldest = await getHistory(alice.socket, { conversationId: id, before: positionOf(middle.messages[0]) })
        expect(oldest.messages.map(message => message.text)).toEqual(Array.from({ length: 30 }, (_unused, index) => `message ${index}`))
        expect(oldest.hasMore).toBe(false)
    })

    it('says there is nothing more when a page is exactly full', async () => {
        const { alice, bob } = await twoUsers()
        await seed(alice, bob, 100, index => new Date(Date.now() - 100_000 + index))

        expect((await getHistory(alice.socket, { conversationId: dm(alice, bob) })).hasMore).toBe(false)
    })

    it('neither skips nor repeats messages saved in the same millisecond across a page boundary', async () => {
        const { alice, bob } = await twoUsers()
        const sameInstant = new Date()
        const seeded = await seed(alice, bob, 230, () => sameInstant)
        const expectedIds = seeded.map(document => document._id.toString()).sort()
        const id = dm(alice, bob)

        const pages = []
        let before
        for (;;) {
            const page = await getHistory(alice.socket, { conversationId: id, before })
            pages.unshift(page.messages.map(message => message.id))
            if (!page.hasMore) break
            before = positionOf(page.messages[0])
        }

        expect(pages.map(page => page.length)).toEqual([30, 100, 100])
        expect(pages.flat()).toEqual(expectedIds)
        // The same way every time.
        expect((await getHistory(alice.socket, { conversationId: id })).messages.map(message => message.id)).toEqual(pages[2])
    })
})

describe('read positions', () => {
    it('start with everything from others unread, and the author’s own messages read', async () => {
        const { alice, bob } = await twoUsers()
        await send(alice.socket, messageTo(dm(alice, bob), 'one'))
        const reply = await send(bob.socket, messageTo(dm(alice, bob), 'two'))
        await send(alice.socket, messageTo(dm(alice, bob), 'three'))

        const forBob = (await login(bob.socket, { username: 'bob' })).conversations[0]
        const forAlice = (await login(alice.socket, { username: 'alice' })).conversations[0]

        // Writing a message means having read up to it: only "three" is new to bob.
        expect(forBob.unreadCount).toBe(1)
        expect(forBob.members.find(member => member.userId === bob.userId).readUpTo).toEqual(positionOf(reply))
        expect(forAlice.unreadCount).toBe(0)
    })

    it('move forward when the reader says so, never backward, and never past the last message', async () => {
        const { alice, bob } = await twoUsers()
        const id = dm(alice, bob)
        const acks = []
        for (const text of ['one', 'two', 'three']) acks.push(await send(alice.socket, messageTo(id, text)))
        // Asked of the same code that builds the list at login (logging in over and over would hit the rate limit).
        const unread = async () => (await conversationsFor(bob.userId))[0].unreadCount
        expect(await unread()).toBe(3)

        expect(await markRead(bob.socket, id, positionOf(acks[1]))).toEqual({ ok: true })
        expect(await unread()).toBe(1)

        // Going back changes nothing.
        expect(await markRead(bob.socket, id, positionOf(acks[0]))).toEqual({ ok: true })
        expect(await unread()).toBe(1)

        // A position from the future is cut back to the last message.
        expect(await markRead(bob.socket, id, { ts: Date.now() + 86_400_000, id: 'f'.repeat(24) })).toEqual({ ok: true })
        expect(await unread()).toBe(0)
        const stored = (await Conversation.findById(id).lean()).members.find(member => member.userId === bob.userId)
        expect({ ts: stored.readUpTo.ts, id: stored.readUpTo.id }).toEqual(positionOf(acks[2]))

        await send(alice.socket, messageTo(id, 'four'))
        expect(await unread()).toBe(1)
    })

    it('tell the reader’s other devices, and nobody else', async () => {
        const { alice } = await twoUsers()
        const account = await app.client()
        const { session } = await account.timeout(3000).emitWithAck('register', { username: 'dana', password: 'a long password' })
        const dana = await login(account, { session })
        const second = await app.client()
        await login(second, { session })
        const ack = await send(alice.socket, messageTo(dm(alice, dana), 'hello'))
        await nextEvent(second, 'conversationUpdated').catch(() => {})
        const seenByAlice = record(alice.socket, 'conversationUpdated')
        const seenBySelf = record(account, 'conversationUpdated')

        const told = nextEvent(second, 'conversationUpdated')
        await markRead(account, dm(alice, dana), positionOf(ack))

        expect((await told).conversation).toMatchObject({ id: dm(alice, dana), unreadCount: 0 })
        await settle()
        expect(seenByAlice).toEqual([])
        expect(seenBySelf).toEqual([])
    })

    it('are refused for a conversation that is not the reader’s, and for nonsense', async () => {
        const { alice, bob } = await twoUsers()
        const carol = await join(app, 'carol')
        const ack = await send(alice.socket, messageTo(dm(alice, bob), 'private'))

        expect(await markRead(carol.socket, dm(alice, bob), positionOf(ack))).toEqual({ ok: false, message: UNKNOWN })
        expect(await markRead(bob.socket, 'no-such', positionOf(ack))).toEqual({ ok: false, message: UNKNOWN })
        for (const upTo of [undefined, 'now', { ts: -1, id: ack.id }, { ts: ack.timestamp, id: 'short' }, { ts: ack.timestamp, id: { $gt: '' } }]) {
            expect(await markRead(bob.socket, dm(alice, bob), upTo)).toEqual({ ok: false, message: 'Invalid position' })
        }
        expect(await markRead(await app.client(), dm(alice, bob), positionOf(ack))).toEqual({ ok: false, message: 'Not logged in' })
    })

    it('cap the unread count shown at 99', async () => {
        const { alice, bob } = await twoUsers()
        await seed(bob, alice, 250, index => new Date(Date.now() - 500_000 + index * 1000))

        const session = await login(await app.client(), { username: 'bob', reservation: bob.reservation })

        // 125 of the 250 are from alice.
        expect(session.conversations[0].unreadCount).toBe(99)
    })
})

describe('the conversation list at login', () => {
    it('holds the user’s conversations, most recent first, and nobody else’s', async () => {
        const { alice, bob } = await twoUsers()
        const carol = await join(app, 'carol')
        await send(alice.socket, messageTo(dm(alice, bob), 'older'))
        await send(carol.socket, messageTo(dm(alice, carol), 'newer'))
        await send(bob.socket, messageTo(dm(bob, carol), 'not for alice'))

        const session = await login(alice.socket, { username: 'alice' })

        expect(session.conversations.map(conversation => conversation.id)).toEqual([dm(alice, carol), dm(alice, bob)])
        expect(session.conversations.map(conversation => conversation.unreadCount)).toEqual([1, 0])
        expect(JSON.stringify(session.conversations)).not.toContain('not for alice')
    })

    it('lists at most the 50 most recent', async () => {
        const alice = await join(app, 'alice')
        await Conversation.insertMany(Array.from({ length: 60 }, (_unused, index) => ({
            _id: `group:seeded-${index}`, kind: 'group', name: `Group ${index}`,
            members: [{ userId: alice.userId, username: 'alice' }],
            lastActivityAt: new Date(Date.now() - index * 60_000),
        })))

        const session = await login(alice.socket, { username: 'alice' })

        expect(session.conversations).toHaveLength(50)
        expect(session.conversations[0]).toMatchObject({ id: 'group:seeded-0', kind: 'group', name: 'Group 0', lastMessage: null })
        expect(session.conversations.at(-1).id).toBe('group:seeded-49')
    })
})
