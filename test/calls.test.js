import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Message } from '../src/models/message.js'
import { settingsFromEnv } from '../src/settings.js'
import { MAX_SDP_LENGTH } from '../src/sockets/calls.js'
import { STUN_SERVERS, createIceServers } from '../src/turn.js'
import {
    PASSWORD, acknowledging, ask, connectTestDatabase, disconnectTestDatabase, dm, getHistory, join, login, messageTo,
    nextEvent, record, register, send, settle, startApp,
} from './helpers.js'

let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
afterEach(async () => {
    vi.restoreAllMocks()
    await app.stop()
})

const start = async (options = {}) => {
    app = await startApp(options)
    return app
}

// Someone with an account, on one device — and `device(person)` for another of theirs.
const account = async name => {
    const socket = acknowledging(await app.client())
    const registered = await register(socket, name)
    if (!registered.ok) throw new Error(`could not register ${name}: ${registered.message}`)
    return { socket, session: registered.session, ...await login(socket, { session: registered.session }) }
}
const device = async person => {
    const socket = acknowledging(await app.client())
    const session = await login(socket, { session: person.session })
    if (!session.ok) throw new Error(`could not log in again: ${session.message}`)
    return socket
}
const guest = async name => {
    const person = await join(app, name)
    acknowledging(person.socket)
    return person
}

const invite = (socket, to, media = 'video') => ask(socket, 'call:invite', { to: to.userId ?? to, media })
const SECRET = /^[A-Za-z0-9_-]{43}$/
const CALL_ID = /^[0-9a-f-]{36}$/

/** A call from alice to bob that bob has accepted. */
const callUnderWay = async (alice, bob, media = 'video') => {
    const ringing = nextEvent(bob.socket, 'call:incoming')
    const invited = await invite(alice.socket, bob, media)
    await ringing
    const accepted = await ask(bob.socket, 'call:accept', { callId: invited.callId })
    return { callId: invited.callId, callerSecret: invited.secret, calleeSecret: accepted.secret }
}

/** The lines calls have left in conversations, once there are `count` of them. */
const callLines = async count => {
    await vi.waitFor(async () => expect(await Message.countDocuments({ kind: 'call' })).toBe(count))
    // (And no more a moment later: written once.)
    await settle()
    const lines = await Message.find({ kind: 'call' }).sort({ createdAt: 1 }).lean()
    expect(lines).toHaveLength(count)
    return lines
}

const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' }
const CANDIDATE = { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' }

describe('calling someone', () => {
    it('rings every device of the person called, and gives only the caller the secret', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await account('bob')
        const phone = await device(bob)
        const laptop = nextEvent(bob.socket, 'call:incoming')
        const pocket = nextEvent(phone, 'call:incoming')

        const invited = await invite(alice.socket, bob, 'audio')

        expect(invited).toEqual({ ok: true, callId: expect.stringMatching(CALL_ID), secret: expect.stringMatching(SECRET) })
        const incoming = { callId: invited.callId, conversationId: dm(alice, bob), media: 'audio', from: { userId: alice.userId, username: 'alice' } }
        expect(await laptop).toEqual(incoming)
        expect(await pocket).toEqual(incoming)
    })

    it('is taken by the first device to accept: the caller is told, and the others stop ringing', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await account('bob')
        const phone = await device(bob)
        const rung = nextEvent(phone, 'call:incoming')
        const invited = await invite(alice.socket, bob)
        await rung
        const told = nextEvent(alice.socket, 'call:accepted')
        const stopped = nextEvent(phone, 'call:ended')
        const ownEnded = record(bob.socket, 'call:ended')

        const accepted = await ask(bob.socket, 'call:accept', { callId: invited.callId })

        expect(accepted).toEqual({ ok: true, secret: expect.stringMatching(SECRET) })
        expect(accepted.secret).not.toBe(invited.secret)
        expect(await told).toEqual({ callId: invited.callId })
        expect(await stopped).toEqual({ callId: invited.callId, reason: 'answered-elsewhere' })
        // Too late on the other device.
        expect(await ask(phone, 'call:accept', { callId: invited.callId }))
            .toEqual({ ok: false, message: 'Answered on another device', reason: 'answered-elsewhere' })
        expect(ownEnded).toEqual([])
    })

    it('can be declined, from any device: both are told, and the conversation says so once', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await account('bob')
        const phone = await device(bob)
        const rung = nextEvent(phone, 'call:incoming')
        const invited = await invite(alice.socket, bob)
        await rung
        const toCaller = nextEvent(alice.socket, 'call:ended')
        const toOther = nextEvent(bob.socket, 'call:ended')

        expect(await ask(phone, 'call:decline', { callId: invited.callId })).toEqual({ ok: true })

        const ended = { callId: invited.callId, reason: 'declined' }
        expect(await toCaller).toEqual(ended)
        expect(await toOther).toEqual(ended)
        const [line] = await callLines(1)
        expect(line).toMatchObject({
            conversationKey: dm(alice, bob), from: alice.userId, fromName: 'alice', kind: 'call',
            data: { media: 'video', outcome: 'declined', durationMs: 0 },
        })
        // Both find it in the conversation — which the call began, there being nothing in it before.
        const history = await getHistory(bob.socket, { conversationId: dm(alice, bob) })
        expect(history.messages.map(message => [message.kind, message.text, message.data.outcome])).toEqual([['call', null, 'declined']])
        // Over: there is nothing left to decline, and either of them can be called again.
        expect(await ask(phone, 'call:decline', { callId: invited.callId })).toEqual({ ok: false, message: 'Unknown call' })
        expect((await invite(bob.socket, alice)).ok).toBe(true)
    })

    it('is unread, for the person called, only if they missed it', async () => {
        await start({ callRingTimeoutMs: 150 })
        const alice = await guest('alice')
        const bob = await guest('bob')
        await send(alice.socket, messageTo(dm(alice, bob), 'are you there?'))
        const unreadFor = async person =>
            (await login(await app.client(), { username: person.username, reservation: person.reservation })).conversations[0]

        // One they declined: they were there. Only the message is unread.
        const invited = await invite(alice.socket, bob)
        await ask(bob.socket, 'call:decline', { callId: invited.callId })
        await callLines(1)
        const declined = await unreadFor(bob)
        expect(declined.unreadCount).toBe(1)
        expect(declined.lastMessage).toMatchObject({ kind: 'call', data: { media: 'video', outcome: 'declined' }, preview: '' })

        // One nobody answered: that is news to the person called — and never to the caller.
        const ended = nextEvent(alice.socket, 'call:ended')
        await invite(alice.socket, bob)
        await ended
        await callLines(2)
        expect((await unreadFor(bob)).unreadCount).toBe(2)
        expect((await unreadFor(alice)).unreadCount).toBe(0)
    })

    it('can be cancelled by the caller before it is answered', async () => {
        await start()
        const alice = await account('alice')
        const other = await device(alice)
        const bob = await guest('bob')
        const rung = nextEvent(bob.socket, 'call:incoming')
        const invited = await invite(alice.socket, bob)
        await rung

        // Not from the caller's other device: the call is this one's.
        expect(await ask(other, 'call:cancel', { callId: invited.callId })).toEqual({ ok: false, message: 'Unknown call' })
        // Not by the person called (who declines instead).
        expect(await ask(bob.socket, 'call:cancel', { callId: invited.callId })).toEqual({ ok: false, message: 'Unknown call' })
        const stopped = nextEvent(bob.socket, 'call:ended')
        expect(await ask(alice.socket, 'call:cancel', { callId: invited.callId })).toEqual({ ok: true })

        expect(await stopped).toEqual({ callId: invited.callId, reason: 'cancelled' })
        expect((await callLines(1))[0].data).toEqual({ media: 'video', outcome: 'cancelled', durationMs: 0 })
    })

    it('ends when either hangs up, and the conversation says how long it lasted', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await account('bob')
        const phone = await device(bob)
        const { callId } = await callUnderWay(alice, bob, 'audio')
        await settle(60)

        // Not from a device that is not in the call; not something to decline or cancel any more.
        expect(await ask(phone, 'call:end', { callId })).toEqual({ ok: false, message: 'Unknown call' })
        expect(await ask(bob.socket, 'call:decline', { callId })).toEqual({ ok: false, message: 'Unknown call' })
        expect(await ask(alice.socket, 'call:cancel', { callId })).toEqual({ ok: false, message: 'Unknown call' })
        const toCaller = nextEvent(alice.socket, 'call:ended')
        const toCallee = nextEvent(bob.socket, 'call:ended')
        expect(await ask(bob.socket, 'call:end', { callId })).toEqual({ ok: true })

        expect(await toCaller).toEqual({ callId, reason: 'ended' })
        expect(await toCallee).toEqual({ callId, reason: 'ended' })
        const [line] = await callLines(1)
        expect(line.data).toMatchObject({ media: 'audio', outcome: 'ended' })
        expect(line.data.durationMs).toBeGreaterThanOrEqual(50)
        expect(line.data.durationMs).toBeLessThan(5000)
        expect(await ask(alice.socket, 'call:end', { callId })).toEqual({ ok: false, message: 'Unknown call' })
    })

    it('hanging up while it rings cancels it for the caller and declines it for the person called', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await guest('bob')
        const first = await invite(alice.socket, bob)
        expect(await ask(alice.socket, 'call:end', { callId: first.callId })).toEqual({ ok: true })
        const second = await invite(alice.socket, bob)
        expect(await ask(bob.socket, 'call:end', { callId: second.callId })).toEqual({ ok: true })

        expect((await callLines(2)).map(line => line.data.outcome)).toEqual(['cancelled', 'declined'])
    })

    it('is missed if nobody answers in time', async () => {
        await start({ callRingTimeoutMs: 150 })
        const alice = await guest('alice')
        const bob = await guest('bob')
        const toCaller = nextEvent(alice.socket, 'call:ended')
        const toCallee = nextEvent(bob.socket, 'call:ended')

        const invited = await invite(alice.socket, bob)

        expect(await toCaller).toEqual({ callId: invited.callId, reason: 'missed' })
        expect(await toCallee).toEqual({ callId: invited.callId, reason: 'missed' })
        expect((await callLines(1))[0].data).toEqual({ media: 'video', outcome: 'missed', durationMs: 0 })
        expect(await ask(bob.socket, 'call:accept', { callId: invited.callId })).toEqual({ ok: false, message: 'Unknown call' })
    })

    it('ends by itself at the longest a call may last', async () => {
        await start({ callMaxMs: 150 })
        const alice = await guest('alice')
        const bob = await guest('bob')
        const ended = nextEvent(alice.socket, 'call:ended')

        const { callId } = await callUnderWay(alice, bob)

        expect(await ended).toEqual({ callId, reason: 'ended' })
        expect((await callLines(1))[0].data.outcome).toBe('ended')
    })

    it('rings a device that logs in while it is ringing', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await account('bob')
        const invited = await invite(alice.socket, bob)
        const late = acknowledging(await app.client())
        const rung = nextEvent(late, 'call:incoming')

        await login(late, { session: bob.session })

        expect(await rung).toMatchObject({ callId: invited.callId, from: { userId: alice.userId } })
        expect((await ask(late, 'call:accept', { callId: invited.callId })).ok).toBe(true)
    })
})

describe('a call that cannot begin', () => {
    it.each([
        ['nobody', () => ({ media: 'video' })],
        ['oneself', alice => ({ to: alice.userId, media: 'video' })],
        ['something that is not a user id', () => ({ to: { $ne: '' }, media: 'video' })],
        ['no kind of call', (_alice, bob) => ({ to: bob.userId })],
        ['an unknown kind of call', (_alice, bob) => ({ to: bob.userId, media: 'hologram' })],
    ])('refuses a call to %s', async (_what, payload) => {
        await start()
        const alice = await guest('alice')
        const bob = await guest('bob')
        const rung = record(bob.socket, 'call:incoming')

        expect(await ask(alice.socket, 'call:invite', payload(alice, bob))).toEqual({ ok: false, message: 'Invalid call' })
        expect(await ask(alice.socket, 'call:invite', 'video')).toEqual({ ok: false, message: 'Invalid call' })

        await settle()
        expect(rung).toEqual([])
        expect(await Message.countDocuments()).toBe(0)
    })

    it('refuses someone who does not exist, someone who is gone, and anyone not logged in', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await account('bob')
        await send(alice.socket, messageTo(dm(alice, bob), 'hello'))
        const stranger = await app.client()

        expect(await invite(alice.socket, 'nobody-of-that-id')).toEqual({ ok: false, message: 'Unknown conversation' })
        // (No bot on this deployment.)
        expect(await invite(alice.socket, 'demo-bot')).toEqual({ ok: false, message: 'Unknown conversation' })
        expect(await invite(stranger, bob)).toEqual({ ok: false, message: 'Not logged in' })
        expect((await ask(bob.socket, 'deleteAccount', { password: PASSWORD })).ok).toBe(true)
        expect(await invite(alice.socket, bob)).toEqual({ ok: false, message: 'This person is no longer here' })
        expect(await Message.countDocuments({ kind: 'call' })).toBe(0)
    })

    it('says the same of someone invisible as of someone who is not connected, and leaves each a missed call', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await account('bob')
        const carol = await account('carol')
        expect((await ask(bob.socket, 'setStatus', { status: 'invisible' })).ok).toBe(true)
        carol.socket.close()
        await vi.waitFor(async () => expect((await invite(alice.socket, carol)).reason).toBe('unavailable'))
        await callLines(1)
        const rung = record(bob.socket, 'call:incoming')
        const shown = nextEvent(bob.socket, 'message')

        const toInvisible = await invite(alice.socket, bob)
        const toAbsent = await invite(alice.socket, carol)

        const answer = { ok: false, message: 'They cannot be reached right now', reason: 'unavailable' }
        expect(toInvisible).toEqual(answer)
        expect(toAbsent).toEqual(answer)
        // The one who is there after all is shown that they were called — and was not rung.
        expect(await shown).toMatchObject({ kind: 'call', from: alice.userId, data: { media: 'video', outcome: 'unavailable', durationMs: 0 } })
        expect(rung).toEqual([])
        expect((await callLines(3)).map(line => line.data.outcome)).toEqual(['unavailable', 'unavailable', 'unavailable'])
        // Neither was a call: the caller can call someone else at once.
        expect((await invite(alice.socket, bob)).reason).toBe('unavailable')
    })

    it('does not ring someone who asked not to be disturbed', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await guest('bob')
        await ask(bob.socket, 'setStatus', { status: 'dnd' })
        const rung = record(bob.socket, 'call:incoming')
        const shown = nextEvent(bob.socket, 'message')

        expect(await invite(alice.socket, bob)).toEqual({ ok: false, message: 'They have asked not to be disturbed', reason: 'dnd' })

        expect(await shown).toMatchObject({ kind: 'call', data: { outcome: 'dnd' } })
        expect(rung).toEqual([])
    })

    it('finds someone in a call busy — the caller as well as the person called — unless they are invisible', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await guest('bob')
        const carol = await guest('carol')
        const { callId } = await callUnderWay(alice, bob)
        const rung = record(bob.socket, 'call:incoming')

        expect(await invite(carol.socket, bob)).toEqual({ ok: false, message: 'They are in another call', reason: 'busy' })
        expect(await invite(carol.socket, alice)).toEqual({ ok: false, message: 'They are in another call', reason: 'busy' })
        // Someone in a call cannot begin another.
        expect(await invite(alice.socket, carol)).toEqual({ ok: false, message: 'You are already in a call', reason: 'in-call' })
        await ask(bob.socket, 'setStatus', { status: 'invisible' })
        expect((await invite(carol.socket, bob)).reason).toBe('unavailable')

        expect(rung).toEqual([])
        // The call itself goes on.
        expect(await ask(alice.socket, 'call:signal', { callId, description: OFFER })).toEqual({ ok: true })
        expect((await callLines(3)).map(line => line.data.outcome)).toEqual(['busy', 'busy', 'unavailable'])
    })

    it('is already busy while it is only ringing', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await guest('bob')
        const carol = await guest('carol')
        await invite(alice.socket, bob)

        expect((await invite(carol.socket, bob)).reason).toBe('busy')
        expect((await invite(bob.socket, carol)).reason).toBe('in-call')
    })

    it('is declined by the bot, after a moment', async () => {
        await start({ demoBot: true })
        const alice = await guest('alice')
        const ended = nextEvent(alice.socket, 'call:ended')

        const invited = await invite(alice.socket, 'demo-bot')

        expect(invited.ok).toBe(true)
        expect(await ended).toEqual({ callId: invited.callId, reason: 'declined' })
        expect((await callLines(1))[0]).toMatchObject({ conversationKey: dm(alice, 'demo-bot'), data: { outcome: 'declined' } })
    })

    it('cannot be asked for without end', async () => {
        await start()
        const alice = await guest('alice')

        const answers = []
        for (let attempt = 0; attempt < 7; attempt += 1) answers.push(await invite(alice.socket, 'nobody-of-that-id'))

        expect(answers.slice(0, 6).every(answer => answer.message === 'Unknown conversation')).toBe(true)
        expect(answers[6]).toEqual({ ok: false, message: 'Too many requests, slow down' })
    })
})

describe('what the two browsers say to each other', () => {
    it('reaches the other device in the call, and nobody else', async () => {
        await start()
        const alice = await account('alice')
        const aliceOther = await device(alice)
        const bob = await account('bob')
        const bobOther = await device(bob)
        const carol = await guest('carol')
        const { callId } = await callUnderWay(alice, bob)
        const bystanders = [aliceOther, bobOther, carol.socket, alice.socket].map(socket => record(socket, 'call:signal'))
        const offered = nextEvent(bob.socket, 'call:signal')

        // (Whatever else a client puts beside the two fields goes no further.)
        expect(await ask(alice.socket, 'call:signal', { callId, description: { ...OFFER, extra: 'x' }, more: 1 })).toEqual({ ok: true })
        expect(await offered).toEqual({ callId, description: OFFER })

        const candidate = nextEvent(alice.socket, 'call:signal')
        expect(await ask(bob.socket, 'call:signal', { callId, candidate: { ...CANDIDATE, extra: 'x' } })).toEqual({ ok: true })
        expect(await candidate).toEqual({ callId, candidate: CANDIDATE })
        // The end of the candidates, and taking an offer back, are passed on too.
        const last = nextEvent(alice.socket, 'call:signal')
        await ask(bob.socket, 'call:signal', { callId, candidate: { candidate: '' } })
        expect(await last).toEqual({ callId, candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null, usernameFragment: null } })
        const back = nextEvent(bob.socket, 'call:signal')
        await ask(alice.socket, 'call:signal', { callId, description: { type: 'rollback' } })
        expect(await back).toEqual({ callId, description: { type: 'rollback', sdp: '' } })

        await settle()
        expect(bystanders.slice(0, 3)).toEqual([[], [], []])
    })

    it('is taken only from a device in the call, once it has been answered', async () => {
        await start()
        const alice = await account('alice')
        const aliceOther = await device(alice)
        const bob = await guest('bob')
        const carol = await guest('carol')
        const received = record(bob.socket, 'call:signal')
        const invited = await invite(alice.socket, bob)
        const signal = (socket, callId = invited.callId) => ask(socket, 'call:signal', { callId, description: OFFER })

        expect(await signal(alice.socket)).toEqual({ ok: false, message: 'The call has not been answered' })
        expect(await signal(bob.socket)).toEqual({ ok: false, message: 'Unknown call' })
        await ask(bob.socket, 'call:accept', { callId: invited.callId })
        expect(await signal(aliceOther)).toEqual({ ok: false, message: 'Unknown call' })
        expect(await signal(carol.socket)).toEqual({ ok: false, message: 'Unknown call' })
        expect(await signal(alice.socket, '00000000-0000-4000-8000-000000000000')).toEqual({ ok: false, message: 'Unknown call' })
        expect(await signal(alice.socket, { $ne: '' })).toEqual({ ok: false, message: 'Unknown call' })

        await settle()
        expect(received).toEqual([])
    })

    it.each([
        ['nothing', {}],
        ['both at once', { description: OFFER, candidate: CANDIDATE }],
        ['a description of no known type', { description: { type: 'gossip', sdp: 'v=0' } }],
        ['a description with nothing in it', { description: { type: 'offer', sdp: '' } }],
        ['a description that is not text', { description: { type: 'offer', sdp: ['v=0'] } }],
        ['a description longer than any is', { description: { type: 'answer', sdp: 'v'.repeat(MAX_SDP_LENGTH + 1) } }],
        ['a rollback with something in it', { description: { type: 'rollback', sdp: 'v=0' } }],
        ['a candidate that is not one', { candidate: 'candidate:1' }],
        ['no candidate at all', { candidate: null }],
        ['a candidate longer than any is', { candidate: { candidate: 'c'.repeat(1001) } }],
        ['a candidate for a line that cannot be', { candidate: { ...CANDIDATE, sdpMLineIndex: -1 } }],
        ['a candidate with a name that is not text', { candidate: { ...CANDIDATE, sdpMid: { a: 1 } } }],
    ])('refuses %s', async (_what, content) => {
        await start()
        const alice = await guest('alice')
        const bob = await guest('bob')
        const { callId } = await callUnderWay(alice, bob)
        const received = record(bob.socket, 'call:signal')

        expect(await ask(alice.socket, 'call:signal', { callId, ...content })).toEqual({ ok: false, message: 'Invalid signal' })

        await settle()
        expect(received).toEqual([])
        expect(alice.socket.connected).toBe(true)
    })

    it('passes a description as long as one may be, and a burst of candidates', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await guest('bob')
        const { callId } = await callUnderWay(alice, bob)
        const received = record(bob.socket, 'call:signal')
        // (Lines of an ordinary length: a description is plain text, a line break every few dozen characters.)
        const large = { type: 'offer', sdp: `a=${'x'.repeat(36)}\r\n`.repeat(MAX_SDP_LENGTH / 40) }
        expect(large.sdp).toHaveLength(MAX_SDP_LENGTH)

        expect(await ask(alice.socket, 'call:signal', { callId, description: large })).toEqual({ ok: true })
        const answers = await Promise.all(Array.from({ length: 60 }, () => ask(alice.socket, 'call:signal', { callId, candidate: CANDIDATE })))

        expect(answers.every(answer => answer.ok)).toBe(true)
        await vi.waitFor(() => expect(received).toHaveLength(61))
        expect(received[0]).toEqual({ callId, description: large })
        expect(alice.socket.connected).toBe(true)
    })
})

describe('a connection lost during a call', () => {
    it('can be taken back by the same device, with its secret, and by nothing else', async () => {
        await start({ callGraceMs: 2000 })
        const alice = await guest('alice')
        const bob = await account('bob')
        const bobOther = await device(bob)
        const carol = await guest('carol')
        const { callId, callerSecret, calleeSecret } = await callUnderWay(alice, bob)
        const lost = nextEvent(alice.socket, 'call:peer')

        bob.socket.close()

        expect(await lost).toEqual({ callId, connected: false })
        // Meanwhile there is nobody to pass anything to.
        expect(await ask(alice.socket, 'call:signal', { callId, description: OFFER }))
            .toEqual({ ok: false, message: 'The other side is not connected right now', reason: 'peer-lost' })
        // Bob's other device knows the call's id, but not the secret; the caller's secret is not his; carol has neither.
        const unknown = { ok: false, message: 'Unknown call' }
        expect(await ask(bobOther, 'call:rejoin', { callId })).toEqual(unknown)
        expect(await ask(bobOther, 'call:rejoin', { callId, secret: callerSecret })).toEqual(unknown)
        expect(await ask(bobOther, 'call:rejoin', { callId, secret: 'é'.repeat(43) })).toEqual(unknown)
        expect(await ask(carol.socket, 'call:rejoin', { callId, secret: calleeSecret })).toEqual(unknown)

        const again = await device(bob)
        const back = nextEvent(alice.socket, 'call:peer')
        expect(await ask(again, 'call:rejoin', { callId, secret: calleeSecret }))
            .toEqual({ ok: true, state: 'active', media: 'video', peerConnected: true })

        expect(await back).toEqual({ callId, connected: true })
        // The call is the new connection's now.
        const offered = nextEvent(again, 'call:signal')
        expect(await ask(alice.socket, 'call:signal', { callId, description: OFFER })).toEqual({ ok: true })
        expect(await offered).toEqual({ callId, description: OFFER })
        expect(await ask(again, 'call:end', { callId })).toEqual({ ok: true })
        expect((await callLines(1))[0].data.outcome).toBe('ended')
    })

    it('ends the call if the device does not come back in time', async () => {
        await start({ callGraceMs: 150 })
        const alice = await guest('alice')
        const bob = await guest('bob')
        const { callId } = await callUnderWay(alice, bob)
        const ended = nextEvent(bob.socket, 'call:ended')

        alice.socket.close()

        expect(await ended).toEqual({ callId, reason: 'failed' })
        expect((await callLines(1))[0].data).toMatchObject({ media: 'video', outcome: 'failed' })
    })

    it('does not wait for a device that signed out: the call ends there and then, as hung up', async () => {
        // (A wait that would outlast the test, were there one.)
        await start({ callGraceMs: 60_000 })
        const alice = await guest('alice')
        const bob = await account('bob')
        const { callId } = await callUnderWay(alice, bob)
        const ended = nextEvent(alice.socket, 'call:ended')

        // Signed out, the connection still open: that device is not coming back to the call.
        expect((await ask(bob.socket, 'logout')).ok).toBe(true)

        expect(await ended).toEqual({ callId, reason: 'ended' })
        expect(await ask(bob.socket, 'call:signal', { callId, description: OFFER })).toEqual({ ok: false, message: 'Not logged in' })
        expect((await callLines(1))[0].data.outcome).toBe('ended')
    })

    it('does not wait for a device that was signed out from another: nor for a caller who signs out while it rings', async () => {
        await start({ callGraceMs: 60_000 })
        const alice = await guest('alice')
        const bob = await account('bob')
        // (Signed in there with the password: a device of its own, not another tab of the first.)
        const phone = acknowledging(await app.client())
        expect((await login(phone, { username: 'bob', password: PASSWORD })).ok).toBe(true)
        const { callId } = await callUnderWay(alice, bob)
        const ended = nextEvent(alice.socket, 'call:ended')

        // Bob's phone signs his other device out — the one in the call.
        const { sessions } = await ask(phone, 'listSessions')
        const other = sessions.find(session => !session.current)
        expect(await ask(phone, 'revokeSession', { id: other.id })).toEqual({ ok: true })

        expect(await ended).toEqual({ callId, reason: 'ended' })

        // And a call still ringing whose caller signs out was cancelled.
        const carol = await account('carol')
        const rung = nextEvent(phone, 'call:incoming')
        const invited = await invite(carol.socket, bob)
        await rung
        const stopped = nextEvent(phone, 'call:ended')
        expect((await ask(carol.socket, 'logout')).ok).toBe(true)
        expect(await stopped).toEqual({ callId: invited.callId, reason: 'cancelled' })
        expect((await callLines(2)).map(line => line.data.outcome)).toEqual(['ended', 'cancelled'])
    })

    it('is a call they missed, to the person called, if the caller\'s connection goes for good while it rings', async () => {
        await start({ callGraceMs: 150 })
        const alice = await guest('alice')
        const bob = await guest('bob')
        const rung = nextEvent(bob.socket, 'call:incoming')
        const invited = await invite(alice.socket, bob)
        await rung
        const ended = nextEvent(bob.socket, 'call:ended')

        alice.socket.close()

        expect(await ended).toEqual({ callId: invited.callId, reason: 'cancelled' })
        expect((await callLines(1))[0].data.outcome).toBe('cancelled')
        // Unread, for the one who never got to answer.
        const { conversations } = await login(await app.client(), { username: bob.username, reservation: bob.reservation })
        expect(conversations[0].unreadCount).toBe(1)
    })

    it('keeps ringing the other devices when one that was ringing goes', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await account('bob')
        const phone = await device(bob)
        const rung = nextEvent(phone, 'call:incoming')
        const invited = await invite(alice.socket, bob)
        await rung

        bob.socket.close()
        await settle()

        expect((await ask(phone, 'call:accept', { callId: invited.callId })).ok).toBe(true)
    })
})

describe('hanging up as the page is closed', () => {
    const leave = (body, headers = { 'Content-Type': 'text/plain;charset=UTF-8' }) =>
        fetch(`${app.url}/call/leave`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

    it('ends the call for whoever holds a device\'s secret, without a socket', async () => {
        await start({ callGraceMs: 5000 })
        const alice = await guest('alice')
        const bob = await guest('bob')
        const { callId, calleeSecret } = await callUnderWay(alice, bob)
        const ended = nextEvent(alice.socket, 'call:ended')
        // (As when a page goes: the connection is cut, and nothing said over it got out.)
        bob.socket.close()

        const response = await leave({ callId, secret: calleeSecret })

        expect(response.status).toBe(204)
        expect(await ended).toEqual({ callId, reason: 'ended' })
        expect((await callLines(1))[0].data.outcome).toBe('ended')
    })

    it('cancels a call that was still ringing', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await guest('bob')
        const invited = await invite(alice.socket, bob)
        const stopped = nextEvent(bob.socket, 'call:ended')

        // (Sent as JSON, by something other than a browser's beacon, it is understood too.)
        await leave({ callId: invited.callId, secret: invited.secret }, { 'Content-Type': 'application/json' })

        expect(await stopped).toEqual({ callId: invited.callId, reason: 'cancelled' })
    })

    it.each([
        ['the id alone', ({ callId }) => ({ callId })],
        ['a secret that is not the call\'s', ({ callId }) => ({ callId, secret: 'x'.repeat(43) })],
        ['a secret that is not text', ({ callId }) => ({ callId, secret: { $ne: '' } })],
        ['another call\'s id', ({ calleeSecret }) => ({ callId: '00000000-0000-4000-8000-000000000000', secret: calleeSecret })],
        ['nothing that can be read', () => 'callId=1&secret=2'],
        ['nothing at all', () => ''],
        ['far too much', ({ callId }) => ({ callId, secret: 'x'.repeat(5000) })],
    ])('does nothing for %s, and says nothing about it', async (_what, body) => {
        await start()
        const alice = await guest('alice')
        const bob = await guest('bob')
        const call = await callUnderWay(alice, bob)
        const ended = record(alice.socket, 'call:ended')

        const response = await leave(body(call))

        // (Too large is turned away before it is read; everything else gets the one answer.)
        expect([204, 413]).toContain(response.status)
        expect(await response.text()).not.toContain(call.callId)
        await settle()
        expect(ended).toEqual([])
        expect(await ask(alice.socket, 'call:signal', { callId: call.callId, description: OFFER })).toEqual({ ok: true })
    })

    it('cannot be tried without end from one address', async () => {
        await start()
        const alice = await guest('alice')
        const bob = await guest('bob')
        const { callId, calleeSecret } = await callUnderWay(alice, bob)
        const ended = record(alice.socket, 'call:ended')

        for (let attempt = 0; attempt < 30; attempt += 1) await leave({ callId, secret: 'x'.repeat(43) })
        // By now even the right secret is not listened to, from here.
        await leave({ callId, secret: calleeSecret })

        await settle()
        expect(ended).toEqual([])
    })
})

describe('the servers a call is set up through', () => {
    const relay = {
        iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
            {
                urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
                username: 'made-up-name', credential: 'made-up-credential', somethingElse: 'not passed on',
            },
        ],
    }
    const answering = (body, status = 201) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

    it('are given only to a device that is in a call', async () => {
        await start()
        const alice = await account('alice')
        const aliceOther = await device(alice)
        const bob = await guest('bob')
        const carol = await guest('carol')
        const invited = await invite(alice.socket, bob)
        const config = socket => ask(socket, 'call:config', { callId: invited.callId })
        const unknown = { ok: false, message: 'Unknown call' }

        expect(await config(alice.socket)).toEqual({ ok: true, iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] })
        // Not the caller's other device, not a stranger — and not the person called until they have accepted.
        expect(await config(aliceOther)).toEqual(unknown)
        expect(await config(carol.socket)).toEqual(unknown)
        expect(await config(bob.socket)).toEqual(unknown)
        expect(await ask(bob.socket, 'call:config', {})).toEqual(unknown)
        await ask(bob.socket, 'call:accept', { callId: invited.callId })
        expect((await config(bob.socket)).ok).toBe(true)
    })

    it('include a relay where one is configured, asked for with the key — which goes nowhere else', async () => {
        const fetched = vi.spyOn(globalThis, 'fetch').mockImplementation(answering(relay))
        await start({ turn: { keyId: 'key-id', apiToken: 'key-token' } })
        const alice = await guest('alice')
        const bob = await guest('bob')
        const { callId } = await callUnderWay(alice, bob)

        const answer = await ask(alice.socket, 'call:config', { callId })

        expect(answer).toEqual({
            ok: true,
            iceServers: [
                { urls: ['stun:stun.cloudflare.com:3478'] },
                {
                    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
                    username: 'made-up-name', credential: 'made-up-credential',
                },
            ],
        })
        expect(JSON.stringify(answer)).not.toContain('key-token')
        const [url, request] = fetched.mock.calls[0]
        expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers')
        expect(request).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer key-token' } })
        // Good for longer than the longest call.
        expect(JSON.parse(request.body).ttl).toBeGreaterThan(3600)
        expect(JSON.parse(request.body).ttl).toBeLessThanOrEqual(48 * 3600)
    })

    it.each([
        ['refuses', () => answering({ error: 'no' }, 403)],
        ['cannot be reached', () => vi.fn(async () => { throw new TypeError('fetch failed') })],
        ['answers something else', () => answering({ iceServers: 'none' })],
        ['answers without a relay', () => answering({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] })],
        ['answers with a relay that is not one', () => answering({ iceServers: [{ urls: ['https://example.com'], username: 'a', credential: 'b' }] })],
    ])('fall back to no relay when the provider %s, and log nothing of the key', async (_what, provider) => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        const servers = createIceServers({ turn: { keyId: 'key-id', apiToken: 'key-token' }, ttlSeconds: 4200, fetch: provider() })

        expect(await servers()).toEqual(STUN_SERVERS)

        expect(logged).toHaveBeenCalledTimes(1)
        expect(JSON.stringify(logged.mock.calls)).not.toMatch(/key-token|key-id/)
    })

    it('never ask the provider where no relay is configured', async () => {
        const provider = vi.fn()

        expect(await createIceServers({ turn: null, ttlSeconds: 4200, fetch: provider })()).toEqual(STUN_SERVERS)
        expect(provider).not.toHaveBeenCalled()
    })

    it('are configured by both halves of the key, or not at all', () => {
        const warn = vi.fn()

        expect(settingsFromEnv({ TURN_KEY_ID: 'key-id', TURN_API_TOKEN: 'key-token' }, warn).turn).toEqual({ keyId: 'key-id', apiToken: 'key-token' })
        expect(settingsFromEnv({}, warn).turn).toBeUndefined()
        expect(warn).not.toHaveBeenCalled()
        expect(settingsFromEnv({ TURN_KEY_ID: 'key-id' }, warn).turn).toBeUndefined()
        expect(settingsFromEnv({ TURN_API_TOKEN: 'key-token' }, warn).turn).toBeUndefined()
        expect(warn).toHaveBeenCalledTimes(2)
        expect(JSON.stringify(warn.mock.calls)).not.toMatch(/key-token|key-id/)
    })
})

describe('what logging in says about calls', () => {
    it('says that this server has them', async () => {
        await start()
        const alice = await guest('alice')

        expect(alice.features.calls).toBe(true)
    })
})
