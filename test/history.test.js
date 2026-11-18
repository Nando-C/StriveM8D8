import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Message } from '../src/models/message.js'
import {
    connectTestDatabase, disconnectTestDatabase, getHistory, login, messageTo, nextEvent,
    onlineUsers, send, sortedKeys, startApp,
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

const twoUsers = async () => {
    const alice = await app.client()
    const bob = await app.client()
    await login(alice, { username: 'alice' })
    const { reservation } = await login(bob, { username: 'bob' })
    return { alice, bob, bobReservation: reservation }
}

const seed = (count, createdAt) => Message.insertMany(
    Array.from({ length: count }, (_unused, index) => ({
        conversationKey: 'alice::bob',
        from: index % 2 ? 'bob' : 'alice',
        to: index % 2 ? 'alice' : 'bob',
        text: `message ${index}`,
        createdAt: createdAt(index),
    })),
)

describe('history', () => {
    it('returns the conversation after one side reconnects with a new socket id', async () => {
        const { alice, bob, bobReservation } = await twoUsers()
        const oldBobId = bob.id
        const first = messageTo(bob.id, 'one')
        const second = messageTo(alice.id, 'two')
        const third = messageTo(bob.id, 'three')

        const liveFirst = nextEvent(bob, 'message')
        const firstAck = await send(alice, first)
        const live = await liveFirst
        const secondAck = await send(bob, second)
        const thirdAck = await send(alice, third)

        bob.close()
        await expect.poll(async () => (await onlineUsers(app)).length).toBe(1)
        const bobAgain = await app.client()
        await login(bobAgain, { username: 'bob', reservation: bobReservation })
        expect(bobAgain.id).not.toBe(oldBobId)

        const history = await getHistory(bobAgain, { withUsername: 'alice' })

        expect(history.ok).toBe(true)
        expect(history.withUsername).toBe('alice')
        expect(history.messages.map(message => message.text)).toEqual(['one', 'two', 'three'])
        expect(history.messages.map(message => message.id)).toEqual([firstAck.id, secondAck.id, thirdAck.id])
        expect(history.messages.map(message => message.clientId))
            .toEqual([first.clientId, second.clientId, third.clientId])
        expect(history.messages[0]).toEqual({
            id: live.id,
            clientId: first.clientId,
            from: 'alice',
            to: 'bob',
            text: 'one',
            timestamp: live.timestamp,
        })
        expect('clientId' in live).toBe(false)
    })

    it('gives both sides the same conversation and keeps other conversations out of it', async () => {
        const { alice, bob } = await twoUsers()
        const carol = await app.client()
        await login(carol, { username: 'carol' })
        await send(alice, messageTo(bob.id, 'for bob'))
        await send(alice, messageTo(carol.id, 'for carol'))

        const fromAlice = await getHistory(alice, { withUsername: 'bob' })
        const fromBob = await getHistory(bob, { withUsername: 'alice' })
        const bobAndCarol = await getHistory(bob, { withUsername: 'carol' })

        expect(fromAlice.messages.map(message => message.text)).toEqual(['for bob'])
        expect(fromBob.messages).toEqual(fromAlice.messages)
        expect(bobAndCarol.messages).toEqual([])
    })

    it('uses exactly the documented message shape, with null for a missing client id', async () => {
        const { alice } = await twoUsers()
        await seed(1, () => new Date())

        const history = await getHistory(alice, { withUsername: 'bob' })

        expect(sortedKeys(history.messages[0])).toEqual(['clientId', 'from', 'id', 'text', 'timestamp', 'to'])
        expect(history.messages[0].id).toEqual(expect.any(String))
        expect(history.messages[0].timestamp).toEqual(expect.any(Number))
        expect(history.messages[0].clientId).toBeNull()
    })

    it('returns only the most recent 100 messages, oldest first', async () => {
        const { alice } = await twoUsers()
        const start = Date.now() - 1_000_000
        await seed(130, index => new Date(start + index * 1000))

        const history = await getHistory(alice, { withUsername: 'bob' })

        expect(history.messages).toHaveLength(100)
        expect(history.messages[0].text).toBe('message 30')
        expect(history.messages.at(-1).text).toBe('message 129')
    })

    it('orders messages saved in the same millisecond by id, the same way every time', async () => {
        const { alice } = await twoUsers()
        const sameInstant = new Date()
        const seeded = await seed(130, () => sameInstant)
        const expectedIds = seeded.map(document => document._id.toString()).sort().slice(-100)

        const first = await getHistory(alice, { withUsername: 'bob' })
        const second = await getHistory(alice, { withUsername: 'bob' })

        expect(first.messages.map(message => message.id)).toEqual(expectedIds)
        expect(second.messages).toEqual(first.messages)
    })

    it('refuses a request from a socket that has not logged in', async () => {
        await twoUsers()
        const stranger = await app.client()

        expect(await getHistory(stranger, { withUsername: 'bob' }))
            .toEqual({ ok: false, withUsername: 'bob', message: 'Not logged in' })
    })

    it('refuses an invalid username and echoes it back', async () => {
        const { alice } = await twoUsers()

        expect(await getHistory(alice, { withUsername: 'a::b' }))
            .toEqual({ ok: false, withUsername: 'a::b', message: 'Invalid username' })
        expect(await getHistory(alice, { withUsername: 42 }))
            .toEqual({ ok: false, withUsername: null, message: 'Invalid username' })
    })
})
