import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conversation } from '../src/models/conversation.js'
import { Message } from '../src/models/message.js'
import {
    connectTestDatabase, disconnectTestDatabase, dm, getHistory, join, login, messageTo, nextEvent, onlineUsers,
    record, send, settle, sortedKeys, startApp,
} from './helpers.js'

let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
beforeEach(async () => {
    app = await startApp()
})
afterEach(() => app.stop())

const threeUsers = async () => ({
    alice: await join(app, 'alice'),
    bob: await join(app, 'bob'),
    carol: await join(app, 'carol'),
})

describe('targeted delivery', () => {
    it('delivers a message to the other member only and acknowledges it to the sender', async () => {
        const { alice, bob, carol } = await threeUsers()
        const payload = messageTo(dm(alice, bob), 'hello bob')

        const delivered = nextEvent(bob.socket, 'message')
        const seenByCarol = record(carol.socket, 'message')
        const seenByAlice = record(alice.socket, 'message')
        const ack = await send(alice.socket, payload)
        const message = await delivered

        expect(sortedKeys(ack)).toEqual(['id', 'ok', 'timestamp'])
        expect(ack.ok).toBe(true)
        expect(sortedKeys(message)).toEqual(['clientId', 'conversationId', 'from', 'fromName', 'id', 'kind', 'text', 'timestamp'])
        expect(message).toMatchObject({
            conversationId: dm(alice, bob), from: alice.userId, fromName: 'alice', kind: 'text', text: 'hello bob',
            // The sender's own id for the message is nobody else's business.
            clientId: null,
        })
        expect(message.id).toBe(ack.id)
        expect(message.timestamp).toBe(ack.timestamp)
        // Bob has it, so anything wrongly sent to the others would have arrived by now.
        await settle()
        expect(seenByCarol).toEqual([])
        expect(seenByAlice).toEqual([])
    })

    it('stores the message under the conversation, by the author’s userId and name', async () => {
        const { alice, bob } = await threeUsers()
        const payload = messageTo(dm(alice, bob), 'hi alice')

        const ack = await send(bob.socket, payload)

        const stored = await Message.find().lean()
        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({
            conversationKey: dm(alice, bob),
            from: bob.userId,
            fromName: 'bob',
            kind: 'text',
            text: 'hi alice',
            clientId: payload.clientId,
        })
        expect(stored[0]).not.toHaveProperty('to')
        expect(stored[0]._id.toString()).toBe(ack.id)
    })

    it('creates the conversation with the first message and tells both members about it', async () => {
        const { alice, bob, carol } = await threeUsers()
        const toldBob = nextEvent(bob.socket, 'conversationUpdated')
        const toldAlice = nextEvent(alice.socket, 'conversationUpdated')
        const toldCarol = record(carol.socket, 'conversationUpdated')

        const ack = await send(alice.socket, messageTo(dm(alice, bob), 'first'))

        const forBob = (await toldBob).conversation
        expect(sortedKeys(forBob)).toEqual(['id', 'kind', 'lastMessage', 'members', 'unreadCount'])
        expect(forBob).toMatchObject({
            id: dm(alice, bob),
            kind: 'direct',
            lastMessage: { id: ack.id, from: alice.userId, fromName: 'alice', preview: 'first', timestamp: ack.timestamp },
            unreadCount: 1,
        })
        expect(forBob.members.map(member => [member.userId, member.username]).sort())
            .toEqual([[alice.userId, 'alice'], [bob.userId, 'bob']].sort())
        // Each member gets their own view: the author has nothing unread.
        expect((await toldAlice).conversation.unreadCount).toBe(0)
        await settle()
        expect(toldCarol).toEqual([])
        expect(await Conversation.countDocuments()).toBe(1)

        // The second message goes into the same conversation, with no second introduction.
        const again = record(bob.socket, 'conversationUpdated')
        const delivered = nextEvent(bob.socket, 'message')
        await send(bob.socket, messageTo(dm(alice, bob), 'second'))
        await send(alice.socket, messageTo(dm(alice, bob), 'third'))
        await delivered
        await settle()
        expect(again).toEqual([])
        expect(await Conversation.countDocuments()).toBe(1)
    })

    it('makes one conversation when both people send their first message at the same moment', async () => {
        const { alice, bob } = await threeUsers()

        const acks = await Promise.all([
            send(alice.socket, messageTo(dm(alice, bob), 'from alice')),
            send(bob.socket, messageTo(dm(alice, bob), 'from bob')),
        ])

        expect(acks.map(ack => ack.ok)).toEqual([true, true])
        expect(await Conversation.countDocuments()).toBe(1)
        expect(await Message.countDocuments()).toBe(2)
    })

    it('keeps the list preview on the newest message, shortened', async () => {
        const { alice, bob } = await threeUsers()
        await send(alice.socket, messageTo(dm(alice, bob), 'one'))

        const ack = await send(bob.socket, messageTo(dm(alice, bob), `  two\n\n${'x'.repeat(200)}`))

        const { lastMessage } = await Conversation.findById(dm(alice, bob)).lean()
        expect(lastMessage).toMatchObject({ id: ack.id, from: bob.userId, fromName: 'bob', timestamp: ack.timestamp })
        expect(lastMessage.preview).toBe(`two ${'x'.repeat(76)}…`)
    })
})

describe('people who are away', () => {
    it('stores a message for someone who is offline, lists it as unread at their next login, and shows it in history', async () => {
        const { alice, bob } = await threeUsers()
        bob.socket.close()
        await expect.poll(async () => (await onlineUsers(app)).length).toBe(2)

        const first = await send(alice.socket, messageTo(dm(alice, bob), 'while you were out'))
        const second = await send(alice.socket, messageTo(dm(alice, bob), 'and another'))
        expect(first.ok && second.ok).toBe(true)

        const back = await app.client()
        const session = await login(back, { username: 'bob', reservation: bob.reservation })

        expect(session.conversations).toHaveLength(1)
        expect(session.conversations[0]).toMatchObject({
            id: dm(alice, bob), kind: 'direct', unreadCount: 2,
            lastMessage: { id: second.id, fromName: 'alice', preview: 'and another' },
        })
        const history = await getHistory(back, { conversationId: dm(alice, bob) })
        expect(history.messages.map(message => message.text)).toEqual(['while you were out', 'and another'])
    })

    it('reaches someone who has never been online at the same time, by their userId alone', async () => {
        const { alice, bob } = await threeUsers()
        bob.socket.close()
        alice.socket.close()
        await expect.poll(async () => (await onlineUsers(app)).length).toBe(1)

        const again = await app.client()
        await login(again, { username: 'alice', reservation: alice.reservation })

        expect((await send(again, messageTo(dm(alice, bob), 'are you there?'))).ok).toBe(true)
    })

    it('delivers live to someone who is connected, on every device, and echoes to the sender’s other devices', async () => {
        const { bob } = await threeUsers()
        const account = await app.client()
        const { session } = await account.timeout(3000).emitWithAck('register', { username: 'dana', password: 'a long password' })
        const dana = await login(account, { session })
        const second = await app.client()
        await login(second, { session })
        const payload = messageTo(dm(dana, bob), 'from my first device')

        const onBob = nextEvent(bob.socket, 'message')
        const onSecond = nextEvent(second, 'message')
        const onSender = record(account, 'message')
        const ack = await send(account, payload)

        expect((await onBob).id).toBe(ack.id)
        // The sender's other device sees it too, and recognises it as their own.
        expect(await onSecond).toMatchObject({ id: ack.id, from: dana.userId, clientId: payload.clientId })
        await settle()
        // The connection it was sent from has the acknowledgement; no echo.
        expect(onSender).toEqual([])

        const toBoth = [nextEvent(account, 'message'), nextEvent(second, 'message')]
        await send(bob.socket, messageTo(dm(dana, bob), 'to both of you'))
        expect((await Promise.all(toBoth)).map(message => message.text)).toEqual(['to both of you', 'to both of you'])
    })
})

describe('send failures', () => {
    const UNKNOWN = { ok: false, message: 'Unknown conversation' }

    it('refuses a conversation that does not exist and is not the sender’s to open', async () => {
        const { alice, bob, carol } = await threeUsers()

        for (const conversationId of [
            'no-such-conversation',
            'group:5b1d8c5e-0000-4000-8000-000000000000',
            // Well formed, but between two other people.
            dm(bob, carol),
            // With someone who does not exist.
            dm(alice, 'nobody-with-this-id'),
            // Not in the order the id is defined in, or not a pair.
            `dm:${[alice.userId, bob.userId].sort().reverse().join('::')}`,
            `dm:${alice.userId}`,
            `dm:${alice.userId}::${bob.userId}::${carol.userId}`,
        ]) {
            expect(await send(alice.socket, messageTo(conversationId))).toEqual(UNKNOWN)
        }
        expect(await Message.countDocuments()).toBe(0)
        expect(await Conversation.countDocuments()).toBe(0)
    })

    it('refuses someone who is not a member, even with the id of a conversation that exists', async () => {
        const { alice, bob, carol } = await threeUsers()
        await send(alice.socket, messageTo(dm(alice, bob), 'private'))
        const seenByBob = record(bob.socket, 'message')

        expect(await send(carol.socket, messageTo(dm(alice, bob), 'let me in'))).toEqual(UNKNOWN)

        await settle()
        expect(seenByBob).toEqual([])
        expect(await Message.countDocuments()).toBe(1)
    })

    it('decides by the stored members, not by what the id says', async () => {
        const { alice, bob, carol } = await threeUsers()
        // A conversation whose id names alice and bob, but whose members are bob and carol.
        await Conversation.create({
            _id: dm(alice, bob),
            kind: 'direct',
            members: [{ userId: bob.userId, username: 'bob' }, { userId: carol.userId, username: 'carol' }],
        })

        expect(await send(alice.socket, messageTo(dm(alice, bob)))).toEqual(UNKNOWN)
        expect((await send(carol.socket, messageTo(dm(alice, bob)))).ok).toBe(true)
    })

    it('refuses a sender who has not logged in', async () => {
        const { alice, bob } = await threeUsers()
        const stranger = await app.client()

        expect(await send(stranger, messageTo(dm(alice, bob))))
            .toEqual({ ok: false, message: 'Not logged in' })
        expect(await Message.countDocuments()).toBe(0)
    })

    it('refuses a message to yourself', async () => {
        const { alice } = await threeUsers()

        expect(await send(alice.socket, messageTo(`dm:${alice.userId}::${alice.userId}`))).toEqual(UNKNOWN)
        expect(await Message.countDocuments()).toBe(0)
    })

    it.each([
        ['empty text', { text: '' }],
        ['text that is only spaces', { text: '   \n ' }],
        ['text over 2000 characters', { text: 'x'.repeat(2001) }],
        ['text that is not a string', { text: { $ne: '' } }],
        ['a missing client id', { clientId: undefined }],
        ['a malformed client id', { clientId: 'has spaces' }],
        ['a missing conversation', { conversationId: undefined }],
        ['a conversation that is not a string', { conversationId: { $ne: '' } }],
        ['an absurdly long conversation id', { conversationId: 'x'.repeat(201) }],
    ])('refuses %s', async (_label, override) => {
        const { alice, bob } = await threeUsers()

        const seenByBob = record(bob.socket, 'message')
        const ack = await send(alice.socket, { ...messageTo(dm(alice, bob)), ...override })

        expect(ack).toEqual({ ok: false, message: 'Invalid message' })
        await settle()
        expect(seenByBob).toEqual([])
        expect(await Message.countDocuments()).toBe(0)
    })

    it('still delivers and stores a valid message sent without an acknowledgement callback', async () => {
        const { alice, bob } = await threeUsers()

        const delivered = nextEvent(bob.socket, 'message')
        alice.socket.emit('sendmessage', messageTo(dm(alice, bob), 'no ack'))

        expect((await delivered).text).toBe('no ack')
        expect(await Message.countDocuments()).toBe(1)
    })
})

describe('when the bookkeeping after a save fails', () => {
    it('still acknowledges and delivers the message: it was saved, and must not be sent twice', async () => {
        const { alice, bob } = await threeUsers()
        await send(alice.socket, messageTo(dm(alice, bob), 'first'))
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        // The message is stored; the update of the conversation that follows is what fails.
        vi.spyOn(Conversation, 'findOneAndUpdate').mockImplementationOnce(() => {
            throw Object.assign(new Error('not primary'), { name: 'MongoServerError' })
        })

        const delivered = nextEvent(bob.socket, 'message')
        const ack = await send(alice.socket, messageTo(dm(alice, bob), 'second'))

        expect(ack).toEqual({ ok: true, id: expect.any(String), timestamp: expect.any(Number) })
        expect((await delivered).id).toBe(ack.id)
        expect(await Message.countDocuments()).toBe(2)
        expect(logged).toHaveBeenCalledWith(expect.stringContaining('after saving a message'), 'MongoServerError')
        // The next message puts the conversation right again.
        const third = await send(alice.socket, messageTo(dm(alice, bob), 'third'))
        expect((await Conversation.findById(dm(alice, bob)).lean()).lastMessage.id).toBe(third.id)
        vi.restoreAllMocks()
    })
})

describe('message kinds', () => {
    it('lets a system message be stored without text, and a text message default its kind', async () => {
        const system = await Message.create({
            conversationKey: 'group:x', from: 'someone', fromName: 'someone', kind: 'system',
            data: { event: 'created' },
        })
        const text = await Message.create({ conversationKey: 'group:x', from: 'someone', fromName: 'someone', text: 'hi' })

        expect(system.text).toBeUndefined()
        expect(system.data).toEqual({ event: 'created' })
        expect(text.kind).toBe('text')
        await expect(Message.create({ conversationKey: 'group:x', from: 'a', fromName: 'a', kind: 'nonsense' })).rejects.toThrow()
    })
})

describe('malformed payloads', () => {
    it('survives every event sent with no payload, null, or a bare string', async () => {
        const { alice, bob } = await threeUsers()
        const stranger = await app.client()

        for (const event of ['login', 'sendmessage', 'getHistory', 'markRead']) {
            stranger.emit(event)
            stranger.emit(event, null)
            stranger.emit(event, 'just a string')
            alice.socket.emit(event)
            alice.socket.emit(event, null)
            alice.socket.emit(event, 'just a string')
        }
        // A callback with no payload still gets an answer.
        const bareAck = await new Promise(resolve => alice.socket.emit('sendmessage', resolve))

        expect(bareAck).toEqual({ ok: false, message: 'Invalid message' })
        expect(await onlineUsers(app)).toHaveLength(3)
        expect(await Message.countDocuments()).toBe(0)

        // The server is still fully working afterwards.
        const delivered = nextEvent(bob.socket, 'message')
        expect((await send(alice.socket, messageTo(dm(alice, bob), 'still alive'))).ok).toBe(true)
        expect((await delivered).text).toBe('still alive')
        expect((await getHistory(alice.socket, { conversationId: dm(alice, bob) })).ok).toBe(true)
        expect((await login(stranger, { username: 'dave' })).ok).toBe(true)
    })
})
