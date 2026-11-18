import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BOT } from '../src/bot.js'
import { conversationsFor } from '../src/conversations.js'
import { Conversation } from '../src/models/conversation.js'
import {
    PASSWORD, acknowledging, ask, connectTestDatabase, disconnectTestDatabase, dm, join, login, markRead,
    messageTo, nextEvent, onlineUsers, positionOf, record, register, send, settle, startApp,
} from './helpers.js'

let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
beforeEach(async () => {
    app = await startApp()
})
afterEach(() => app.stop())

// Two guests. Bob's client acknowledges what it is sent, as the real client does.
const twoUsers = async () => {
    const alice = await join(app, 'alice')
    const bob = await join(app, 'bob')
    acknowledging(bob.socket)
    return { alice, bob, id: dm(alice, bob) }
}

const memberIn = (view, user) => view.members.find(member => member.userId === user.userId)
const stored = async (id, user) => (await Conversation.findById(id).lean()).members.find(member => member.userId === user.userId)
const plain = position => (position ? { ts: position.ts, id: position.id } : null)

describe('delivered', () => {
    it('is recorded when the recipient’s device acknowledges the message, and the sender is told', async () => {
        const { alice, bob, id } = await twoUsers()
        const carol = await join(app, 'carol')
        const seenByCarol = record(carol.socket, 'receipt')
        const seenByBob = record(bob.socket, 'receipt')

        const told = nextEvent(alice.socket, 'receipt')
        const ack = await send(alice.socket, messageTo(id, 'hello'))

        expect(await told).toEqual({ conversationId: id, userId: bob.userId, deliveredUpTo: positionOf(ack), readUpTo: null })
        expect(plain((await stored(id, bob)).deliveredUpTo)).toEqual(positionOf(ack))
        // Nobody outside the conversation hears of it, and nobody is told about themself:
        // what bob is told is where alice stands (she has, of course, read her own message).
        await settle()
        expect(seenByCarol).toEqual([])
        expect(seenByBob).toEqual([{ conversationId: id, userId: alice.userId, deliveredUpTo: positionOf(ack), readUpTo: positionOf(ack) }])
    })

    it('is not recorded for a device that never acknowledges, however long it is given', async () => {
        await app.stop()
        app = await startApp({ deliveryAckTimeoutMs: 100 })
        const alice = await join(app, 'alice')
        const bob = await join(app, 'bob') // receives, but says nothing back
        const seen = record(alice.socket, 'receipt')

        const delivered = nextEvent(bob.socket, 'message')
        await send(alice.socket, messageTo(dm(alice, bob), 'hello'))
        await delivered
        // Well past the time the server waits for an acknowledgement.
        await settle(500)

        expect(seen).toEqual([])
        expect((await stored(dm(alice, bob), bob)).deliveredUpTo).toBeUndefined()
    })

    it('takes one device: a second acknowledgement of the same message tells nobody anything new', async () => {
        const alice = await join(app, 'alice')
        const first = acknowledging(await app.client())
        const account = await register(first, 'bob')
        const bob = await login(first, { session: account.session })
        const second = acknowledging(await app.client())
        await login(second, { session: account.session })
        const seen = record(alice.socket, 'receipt')

        const both = [nextEvent(first, 'message'), nextEvent(second, 'message')]
        const ack = await send(alice.socket, messageTo(dm(alice, bob), 'to both devices'))
        await Promise.all(both)
        await settle(300)

        expect(seen).toEqual([{ conversationId: dm(alice, bob), userId: bob.userId, deliveredUpTo: positionOf(ack), readUpTo: null }])
    })

    it('reaches every device of the sender', async () => {
        const first = await app.client()
        const account = await register(first, 'alice')
        const alice = await login(first, { session: account.session })
        const second = await app.client()
        await login(second, { session: account.session })
        const bob = await join(app, 'bob')
        acknowledging(bob.socket)

        const told = [nextEvent(first, 'receipt'), nextEvent(second, 'receipt')]
        await send(first, messageTo(dm(alice, bob), 'hello'))

        expect((await Promise.all(told)).map(receipt => receipt.userId)).toEqual([bob.userId, bob.userId])
    })

    it('happens at login for what arrived while away: the device now holds the badge', async () => {
        const { alice, bob, id } = await twoUsers()
        bob.socket.close()
        await expect.poll(async () => (await onlineUsers(app)).length).toBe(1)
        const first = await send(alice.socket, messageTo(id, 'one'))
        const second = await send(alice.socket, messageTo(id, 'two'))
        expect((await stored(id, bob)).deliveredUpTo).toBeUndefined()
        expect(first.ok).toBe(true)

        const told = nextEvent(alice.socket, 'receipt')
        await login(await app.client(), { username: 'bob', reservation: bob.reservation })

        // Delivered, not read.
        expect(await told).toEqual({ conversationId: id, userId: bob.userId, deliveredUpTo: positionOf(second), readUpTo: null })
    })
})

describe('seen', () => {
    it('is told to the sender when the recipient reads, and implies delivered', async () => {
        const alice = await join(app, 'alice')
        const bob = await join(app, 'bob') // does not acknowledge: reading is what proves it arrived
        const id = dm(alice, bob)
        const ack = await send(alice.socket, messageTo(id, 'hello'))

        const told = nextEvent(alice.socket, 'receipt')
        expect(await markRead(bob.socket, id, positionOf(ack))).toEqual({ ok: true })

        expect(await told).toEqual({ conversationId: id, userId: bob.userId, deliveredUpTo: positionOf(ack), readUpTo: positionOf(ack) })
    })

    it('only ever moves forward: reading something older tells nobody anything', async () => {
        const { alice, bob, id } = await twoUsers()
        const first = await send(alice.socket, messageTo(id, 'one'))
        const second = await send(alice.socket, messageTo(id, 'two'))
        await markRead(bob.socket, id, positionOf(second))
        await settle()
        const seen = record(alice.socket, 'receipt')

        await markRead(bob.socket, id, positionOf(first))
        await markRead(bob.socket, id, positionOf(second))
        await settle()

        expect(seen).toEqual([])
        expect(plain((await stored(id, bob)).readUpTo)).toEqual(positionOf(second))
    })

    it('follows from replying: whoever writes has read what came before', async () => {
        const { alice, bob, id } = await twoUsers()
        acknowledging(alice.socket)
        await send(alice.socket, messageTo(id, 'are you there?'))
        await settle()

        const receipts = record(alice.socket, 'receipt')
        const reply = await send(bob.socket, messageTo(id, 'yes'))
        await expect.poll(() => receipts.at(-1)?.readUpTo).toEqual(positionOf(reply))
    })

    it('is refused for a conversation that is not the reader’s', async () => {
        const { alice, bob, id } = await twoUsers()
        const carol = await join(app, 'carol')
        const ack = await send(alice.socket, messageTo(id, 'private'))
        const seen = record(alice.socket, 'receipt')
        await settle()
        seen.length = 0

        expect(await markRead(carol.socket, id, positionOf(ack))).toEqual({ ok: false, message: 'Unknown conversation' })
        await settle()

        expect(seen).toEqual([])
        expect(bob.userId).toBeDefined()
    })
})

describe('what each member is told about the others', () => {
    it('is re-sent in full at login, so a reconnect picks up whatever was missed', async () => {
        const { alice, bob, id } = await twoUsers()
        const ack = await send(alice.socket, messageTo(id, 'hello'))
        alice.socket.close()
        await expect.poll(async () => (await onlineUsers(app)).length).toBe(1)
        // Read while the sender is away: no receipt reaches anyone.
        await markRead(bob.socket, id, positionOf(ack))

        const back = await login(await app.client(), { username: 'alice', reservation: alice.reservation })

        expect(memberIn(back.conversations[0], bob)).toMatchObject({ deliveredUpTo: positionOf(ack), readUpTo: positionOf(ack) })
    })
})

describe('an invisible reader', () => {
    // Bob goes invisible, then receives and reads a message from alice.
    const readInvisibly = async () => {
        const { alice, bob, id } = await twoUsers()
        const before = await send(alice.socket, messageTo(id, 'before'))
        await markRead(bob.socket, id, positionOf(before))
        await ask(bob.socket, 'setStatus', { status: 'invisible' })
        await settle()
        const receipts = record(alice.socket, 'receipt')

        const delivered = nextEvent(bob.socket, 'message')
        const after = await send(alice.socket, messageTo(id, 'after'))
        await delivered
        expect(await markRead(bob.socket, id, positionOf(after))).toEqual({ ok: true })
        await settle(300)
        return { alice, bob, id, before, after, receipts }
    }

    it('gives nothing away live: no receipt for the delivery, none for the reading', async () => {
        const { receipts } = await readInvisibly()

        expect(receipts).toEqual([])
    })

    it('gives nothing away to a reload either: others are still sent the old positions', async () => {
        const { alice, bob, id, before, after } = await readInvisibly()

        const again = await login(await app.client(), { username: 'alice', reservation: alice.reservation })

        // What alice is told is where he stood when he vanished…
        expect(memberIn(again.conversations[0], bob)).toMatchObject({ deliveredUpTo: positionOf(before), readUpTo: positionOf(before) })
        expect(JSON.stringify(memberIn(again.conversations[0], bob))).not.toContain(after.id)
        // …while he himself is told the truth, so his own unread count is right.
        const own = (await conversationsFor(bob.userId))[0]
        expect(own.unreadCount).toBe(0)
        expect(memberIn(own, bob)).toMatchObject({ deliveredUpTo: positionOf(after), readUpTo: positionOf(after) })
        expect(plain((await stored(id, bob)).published.readUpTo)).toEqual(positionOf(before))
    })

    it('catches up, with one receipt, when they are visible again', async () => {
        const { alice, bob, id, after, receipts } = await readInvisibly()

        const told = nextEvent(alice.socket, 'receipt')
        await ask(bob.socket, 'setStatus', { status: 'online' })

        expect(await told).toEqual({ conversationId: id, userId: bob.userId, deliveredUpTo: positionOf(after), readUpTo: positionOf(after) })
        await settle()
        expect(receipts).toHaveLength(1)
        // And only then: changing between visible statuses afterwards says nothing more.
        await ask(bob.socket, 'setStatus', { status: 'away' })
        await settle()
        expect(receipts).toHaveLength(1)
    })

    it('holds back what a login delivers, too', async () => {
        const { alice, bob, id } = await twoUsers()
        await ask(bob.socket, 'setStatus', { status: 'invisible' })
        bob.socket.close()
        await expect.poll(() => app.io.sockets.sockets.size).toBe(1)
        await send(alice.socket, messageTo(id, 'while you were away'))
        const receipts = record(alice.socket, 'receipt')

        await login(await app.client(), { username: 'bob', reservation: bob.reservation })
        await settle(300)

        expect(receipts).toEqual([])
        expect(plain((await stored(id, bob)).deliveredUpTo)).not.toBeNull()
        expect((await stored(id, bob)).published?.deliveredUpTo).toBeUndefined()
    })
})

describe('the demo bot', () => {
    it('has received a message the moment it is sent, and has read it by the time it answers', async () => {
        await app.stop()
        app = await startApp({ demoBot: true })
        const alice = await join(app, 'alice')
        acknowledging(alice.socket)
        const id = dm(alice, BOT.id)
        const receipts = record(alice.socket, 'receipt')

        const answered = nextEvent(alice.socket, 'message')
        const ack = await send(alice.socket, messageTo(id, 'hello'))
        await expect.poll(() => receipts[0]).toEqual({ conversationId: id, userId: BOT.id, deliveredUpTo: positionOf(ack), readUpTo: null })

        const answer = await answered
        await expect.poll(() => receipts.at(-1)?.readUpTo).toEqual({ ts: answer.timestamp, id: answer.id })
    })
})

describe('accounts on several devices', () => {
    it('are told about a receipt on each, and a device that reads clears the other’s badge', async () => {
        const first = acknowledging(await app.client())
        const account = await register(first, 'bob')
        const bob = await login(first, { session: account.session })
        const second = acknowledging(await app.client())
        await login(second, { username: 'bob', password: PASSWORD })
        const alice = await join(app, 'alice')
        const ack = await send(alice.socket, messageTo(dm(alice, bob), 'hello'))
        await settle()

        const cleared = nextEvent(second, 'conversationUpdated')
        const seenByFirst = record(first, 'receipt')
        const seenBySecond = record(second, 'receipt')
        await markRead(first, dm(alice, bob), positionOf(ack))

        expect((await cleared).conversation.unreadCount).toBe(0)
        // A receipt is for the *other* members; the reader's devices get their own view instead.
        await settle()
        expect(seenByFirst).toEqual([])
        expect(seenBySecond).toEqual([])
    })
})
