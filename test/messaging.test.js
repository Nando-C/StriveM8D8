import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Message } from '../src/models/message.js'
import {
    connectTestDatabase, disconnectTestDatabase, getHistory, login, messageTo, nextEvent, onlineUsers,
    record, send, settle, sortedKeys, startApp,
} from './helpers.js'

let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
beforeEach(async () => {
    app = await startApp()
})
afterEach(async () => {
    await app.stop()
    await Message.deleteMany({})
})

const threeUsers = async () => {
    const alice = await app.client()
    const bob = await app.client()
    const carol = await app.client()
    await login(alice, { username: 'alice' })
    await login(bob, { username: 'bob' })
    await login(carol, { username: 'carol' })
    return { alice, bob, carol }
}

describe('targeted delivery', () => {
    it('delivers a message to the recipient only and acknowledges it to the sender', async () => {
        const { alice, bob, carol } = await threeUsers()
        const payload = messageTo(bob.id, 'hello bob')

        const delivered = nextEvent(bob, 'message')
        const seenByCarol = record(carol, 'message')
        const seenByAlice = record(alice, 'message')
        const ack = await send(alice, payload)
        const message = await delivered

        expect(sortedKeys(ack)).toEqual(['id', 'ok', 'timestamp'])
        expect(ack.ok).toBe(true)
        expect(sortedKeys(message)).toEqual(['from', 'fromId', 'id', 'text', 'timestamp'])
        expect(message).toMatchObject({ from: 'alice', fromId: alice.id, text: 'hello bob' })
        expect(message.id).toBe(ack.id)
        expect(message.timestamp).toBe(ack.timestamp)
        // Bob has it, so anything wrongly sent to the others would have arrived by now.
        await settle()
        expect(seenByCarol).toEqual([])
        expect(seenByAlice).toEqual([])
    })

    it('stores the message under the sorted username pair with the client id', async () => {
        const { alice, bob } = await threeUsers()
        const payload = messageTo(alice.id, 'hi alice')

        const ack = await send(bob, payload)

        const stored = await Message.find().lean()
        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({
            conversationKey: 'alice::bob',
            from: 'bob',
            to: 'alice',
            text: 'hi alice',
            clientId: payload.clientId,
        })
        expect(stored[0]._id.toString()).toBe(ack.id)
    })
})

describe('send failures', () => {
    it('refuses an unknown recipient', async () => {
        const { alice } = await threeUsers()

        expect(await send(alice, messageTo('no-such-socket')))
            .toEqual({ ok: false, message: 'Recipient is not online' })
        expect(await Message.countDocuments()).toBe(0)
    })

    it('refuses a recipient who has gone offline', async () => {
        const { alice, bob } = await threeUsers()
        const staleId = bob.id
        bob.close()
        await expect.poll(async () => (await onlineUsers(app)).length).toBe(2)

        expect(await send(alice, messageTo(staleId)))
            .toEqual({ ok: false, message: 'Recipient is not online' })
        expect(await Message.countDocuments()).toBe(0)
    })

    it('refuses a sender who has not logged in', async () => {
        const { bob } = await threeUsers()
        const stranger = await app.client()

        expect(await send(stranger, messageTo(bob.id)))
            .toEqual({ ok: false, message: 'Not logged in' })
        expect(await Message.countDocuments()).toBe(0)
    })

    it('refuses a message to yourself', async () => {
        const { alice } = await threeUsers()

        expect(await send(alice, messageTo(alice.id)))
            .toEqual({ ok: false, message: 'Cannot message yourself' })
        expect(await Message.countDocuments()).toBe(0)
    })

    it.each([
        ['empty text', { text: '' }],
        ['text over 2000 characters', { text: 'x'.repeat(2001) }],
        ['a missing client id', { clientId: undefined }],
        ['a malformed client id', { clientId: 'has spaces' }],
        ['a missing recipient', { toUserId: undefined }],
    ])('refuses %s', async (_label, override) => {
        const { alice, bob } = await threeUsers()

        const seenByBob = record(bob, 'message')
        const ack = await send(alice, { ...messageTo(bob.id), ...override })

        expect(ack).toEqual({ ok: false, message: 'Invalid message' })
        await settle()
        expect(seenByBob).toEqual([])
        expect(await Message.countDocuments()).toBe(0)
    })

    it('still delivers and stores a valid message sent without an acknowledgement callback', async () => {
        const { alice, bob } = await threeUsers()

        const delivered = nextEvent(bob, 'message')
        alice.emit('sendmessage', messageTo(bob.id, 'no ack'))

        expect((await delivered).text).toBe('no ack')
        expect(await Message.countDocuments()).toBe(1)
    })
})

describe('malformed payloads', () => {
    it('survives every event sent with no payload, null, or a bare string', async () => {
        const { alice, bob } = await threeUsers()
        const stranger = await app.client()

        for (const event of ['login', 'sendmessage', 'getHistory']) {
            stranger.emit(event)
            stranger.emit(event, null)
            stranger.emit(event, 'just a string')
            alice.emit(event)
            alice.emit(event, null)
            alice.emit(event, 'just a string')
        }
        // A callback with no payload still gets an answer.
        const bareAck = await new Promise(resolve => alice.emit('sendmessage', resolve))

        expect(bareAck).toEqual({ ok: false, message: 'Invalid message' })
        expect(await onlineUsers(app)).toHaveLength(3)
        expect(await Message.countDocuments()).toBe(0)

        // The server is still fully working afterwards.
        const delivered = nextEvent(bob, 'message')
        expect((await send(alice, messageTo(bob.id, 'still alive'))).ok).toBe(true)
        expect((await delivered).text).toBe('still alive')
        expect((await getHistory(alice, { withUsername: 'bob' })).ok).toBe(true)
        expect((await login(stranger, { username: 'dave' })).ok).toBe(true)
    })
})
