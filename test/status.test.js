import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Identity } from '../src/models/identity.js'
import { BOT_STATUS_TEXT, cleanStatusText, publicPresence } from '../src/status.js'
import {
    PASSWORD, ask, connectTestDatabase, disconnectTestDatabase, dm, getHistory, getJson, join, login, messageTo,
    nextEvent, onlineUsers, record, register, send, settle, sortedKeys, startApp,
} from './helpers.js'

let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
beforeEach(async () => {
    app = await startApp()
})
afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await app.stop()
})

const setStatus = (socket, payload) => ask(socket, 'setStatus', payload)
const setIdle = (socket, idle) => ask(socket, 'setIdle', { idle })
const shown = async username => (await onlineUsers(app)).find(user => user.username === username)

describe('what everyone else is shown', () => {
    // Every combination of what can be chosen and whether the user is idle.
    it.each([
        ['online', false, 'online'],
        ['online', true, 'away'],
        ['away', false, 'away'],
        ['away', true, 'away'],
        ['dnd', false, 'dnd'],
        // Do not disturb is a choice: being idle does not turn it into "away".
        ['dnd', true, 'dnd'],
        ['invisible', false, null],
        ['invisible', true, null],
    ])('chosen %s, idle %s → %s', (status, idle, expected) => {
        const result = publicPresence({ status, statusText: 'at lunch', idle })

        if (expected === null) expect(result).toBeNull()
        else expect(result).toEqual({ status: expected, statusText: 'at lunch' })
    })

    it('is online with no text for someone who never chose anything', () => {
        expect(publicPresence()).toEqual({ status: 'online', statusText: '' })
        expect(publicPresence({ status: undefined, statusText: undefined })).toEqual({ status: 'online', statusText: '' })
    })

    it('has its text stored as one clean line', () => {
        expect(cleanStatusText('  at\tlunch\n\nback   soon ')).toBe('at lunch back soon')
        expect(cleanStatusText('a\u0000b\u007fc')).toBe('a b c')
        expect(cleanStatusText('')).toBe('')
    })
})

describe('setting a status', () => {
    it('tells everyone else, answers the user with what they chose, and stores it', async () => {
        const alice = await join(app, 'alice')
        const bob = await join(app, 'bob')
        expect(alice.ownStatus).toEqual({ status: 'online', statusText: '', statusClearAt: null })
        const seenByAlice = record(alice.socket, 'presence')

        const told = nextEvent(bob.socket, 'presence')
        const answer = await setStatus(alice.socket, { status: 'dnd', text: '  in a   meeting ' })

        expect(answer).toEqual({ ok: true, status: 'dnd', statusText: 'in a meeting', statusClearAt: null })
        expect(await told).toEqual({ userId: alice.userId, status: 'dnd', statusText: 'in a meeting' })
        expect(await shown('alice')).toEqual({
            userId: alice.userId, username: 'alice', kind: 'guest', status: 'dnd', statusText: 'in a meeting',
        })
        expect(await Identity.findOne({ userId: alice.userId }).lean()).toMatchObject({ status: 'dnd', statusText: 'in a meeting' })
        // The user's own connection is answered, not told.
        await settle()
        expect(seenByAlice).toEqual([])
    })

    it('changes only what is given', async () => {
        const alice = await join(app, 'alice')
        await setStatus(alice.socket, { status: 'away', text: 'at lunch' })

        expect(await setStatus(alice.socket, { status: 'dnd' })).toMatchObject({ status: 'dnd', statusText: 'at lunch' })
        expect(await setStatus(alice.socket, { text: '' })).toMatchObject({ status: 'dnd', statusText: '' })
        expect(await setStatus(alice.socket, {})).toMatchObject({ ok: true, status: 'dnd', statusText: '' })
    })

    it('says nothing to anyone when nothing they can see has changed', async () => {
        const alice = await join(app, 'alice')
        const bob = await join(app, 'bob')
        await setStatus(alice.socket, { status: 'away' })
        const seen = []
        bob.socket.onAny((event, payload) => seen.push([event, payload]))

        await setStatus(alice.socket, { status: 'away' })
        await setStatus(alice.socket, { text: '' })
        await setIdle(alice.socket, true) // already shown as away
        await settle()

        expect(seen).toEqual([])
    })

    it('is the same after a reconnect, and on another device', async () => {
        const first = await app.client()
        const account = await register(first, 'alice')
        await login(first, { session: account.session })
        await setStatus(first, { status: 'dnd', text: 'writing' })
        first.close()
        await expect.poll(() => onlineUsers(app)).toEqual([])

        const bob = await join(app, 'bob')
        const announced = nextEvent(bob.socket, 'newLogin')
        const again = await login(await app.client(), { username: 'alice', password: PASSWORD })

        expect(again.ownStatus).toEqual({ status: 'dnd', statusText: 'writing', statusClearAt: null })
        // She comes back as she left: others are shown the status straight away.
        expect(await announced).toMatchObject({ username: 'alice', status: 'dnd', statusText: 'writing' })
    })

    it('reaches the user’s other devices as their own status, and nobody else as that', async () => {
        const first = await app.client()
        const account = await register(first, 'alice')
        await login(first, { session: account.session })
        const second = await app.client()
        await login(second, { session: account.session })
        const bob = await join(app, 'bob')
        const seenByBob = record(bob.socket, 'ownStatus')
        const seenByFirst = record(first, 'ownStatus')

        const told = nextEvent(second, 'ownStatus')
        await setStatus(first, { status: 'invisible', text: 'heads down' })

        expect(await told).toEqual({ status: 'invisible', statusText: 'heads down', statusClearAt: null })
        await settle()
        expect(seenByBob).toEqual([])
        expect(seenByFirst).toEqual([])
    })

    it.each([
        ['an unknown status', { status: 'busy' }, 'Invalid status'],
        ['a status that is not text', { status: { $ne: '' } }, 'Invalid status'],
        ['a text that is not text', { text: 42 }, 'Invalid status'],
        ['a text that is too long', { text: 'x'.repeat(81) }, 'A status message can be at most 80 characters'],
        ['a lifetime of zero', { text: 'hi', clearAfterMinutes: 0 }, 'Invalid status'],
        ['a lifetime that is not a whole number', { text: 'hi', clearAfterMinutes: 1.5 }, 'Invalid status'],
        ['a lifetime of more than a week', { text: 'hi', clearAfterMinutes: 7 * 24 * 60 + 1 }, 'Invalid status'],
        ['a lifetime that is not a number', { text: 'hi', clearAfterMinutes: '30' }, 'Invalid status'],
        ['no payload at all', null, 'Invalid status'],
    ])('refuses %s', async (_label, payload, message) => {
        const alice = await join(app, 'alice')
        const bob = await join(app, 'bob')
        const seen = record(bob.socket, 'presence')

        expect(await setStatus(alice.socket, payload)).toEqual({ ok: false, message })
        await settle()

        expect(seen).toEqual([])
        expect(await shown('alice')).toMatchObject({ status: 'online', statusText: '' })
    })

    it('accepts a text of exactly 80 characters, measured after it is tidied', async () => {
        const alice = await join(app, 'alice')

        const answer = await setStatus(alice.socket, { text: `  ${'x'.repeat(80)}  ` })

        expect(answer.statusText).toHaveLength(80)
    })

    it('needs a login, and is limited', async () => {
        const alice = await join(app, 'alice')
        expect(await setStatus(await app.client(), { status: 'away' })).toEqual({ ok: false, message: 'Not logged in' })
        expect(await setIdle(await app.client(), true)).toEqual({ ok: false, message: 'Not logged in' })
        expect(await setIdle(alice.socket, 'yes')).toEqual({ ok: false, message: 'Invalid request' })

        const answers = []
        for (let index = 0; index < 11; index++) answers.push(await setStatus(alice.socket, { status: index % 2 ? 'away' : 'dnd' }))

        expect(answers.slice(0, 10).every(answer => answer.ok)).toBe(true)
        expect(answers[10]).toEqual({ ok: false, message: 'Too many requests, slow down' })
    })
})

describe('being idle', () => {
    it('shows an online user as away, and as online again the moment they are back', async () => {
        const alice = await join(app, 'alice')
        const bob = await join(app, 'bob')

        const away = nextEvent(bob.socket, 'presence')
        expect(await setIdle(alice.socket, true)).toEqual({ ok: true })
        expect(await away).toEqual({ userId: alice.userId, status: 'away', statusText: '' })

        const back = nextEvent(bob.socket, 'presence')
        await setIdle(alice.socket, false)
        expect(await back).toEqual({ userId: alice.userId, status: 'online', statusText: '' })
        // What she chose never changed.
        expect((await Identity.findOne({ userId: alice.userId }).lean()).status).toBe('online')
    })

    it('needs every device to be idle', async () => {
        const first = await app.client()
        const account = await register(first, 'alice')
        await login(first, { session: account.session })
        const second = await app.client()
        await login(second, { session: account.session })
        const bob = await join(app, 'bob')
        const seen = record(bob.socket, 'presence')

        await setIdle(first, true)
        await settle()
        expect(seen).toEqual([])
        expect(await shown('alice')).toMatchObject({ status: 'online' })

        await setIdle(second, true)
        await expect.poll(async () => (await shown('alice')).status).toBe('away')

        // The device still in use goes: what is left is all idle.
        await setIdle(second, false)
        await expect.poll(async () => (await shown('alice')).status).toBe('online')
        second.close()
        await expect.poll(async () => (await shown('alice')).status).toBe('away')
        expect(seen.map(event => event.status)).toEqual(['away', 'online', 'away'])
    })

    it('does not turn do not disturb into away, and is forgotten with the connection', async () => {
        const alice = await join(app, 'alice')
        await setStatus(alice.socket, { status: 'dnd' })
        await setIdle(alice.socket, true)
        expect(await shown('alice')).toMatchObject({ status: 'dnd' })

        await setStatus(alice.socket, { status: 'online' })
        expect(await shown('alice')).toMatchObject({ status: 'away' })
        // A new connection is in use until it says otherwise.
        const again = await app.client()
        await login(again, { username: 'alice', reservation: alice.reservation })
        expect(await shown('alice')).toMatchObject({ status: 'online' })
    })
})

describe('being invisible', () => {
    it('makes the user disappear for everyone else, and reappear when they choose to', async () => {
        const alice = await join(app, 'alice')
        const bob = await join(app, 'bob')

        const left = nextEvent(bob.socket, 'userLeft')
        expect(await setStatus(alice.socket, { status: 'invisible' })).toMatchObject({ ok: true, status: 'invisible' })
        expect(await left).toEqual({ userId: alice.userId })
        expect((await onlineUsers(app)).map(user => user.username)).toEqual(['bob'])

        const back = nextEvent(bob.socket, 'newLogin')
        await setStatus(alice.socket, { status: 'online', text: 'hello again' })
        expect(await back).toEqual({ userId: alice.userId, username: 'alice', kind: 'guest', status: 'online', statusText: 'hello again' })
    })

    it('gives away nothing afterwards: not in any list, not in any event, whatever the user does', async () => {
        const first = await app.client()
        const account = await register(first, 'alice')
        const alice = await login(first, { session: account.session })
        await setStatus(first, { status: 'invisible' })
        const bob = await join(app, 'bob')
        const seen = []
        bob.socket.onAny((event, payload) => seen.push([event, payload]))

        // Everything that would normally be announced.
        await setStatus(first, { text: 'nobody should see this' })
        await setIdle(first, true)
        await setIdle(first, false)
        const second = await app.client()
        const again = await login(second, { session: account.session })
        second.close()
        await expect.poll(() => app.io.sockets.sockets.has(second.id)).toBe(false)
        const carol = await join(app, 'carol')
        first.close()
        await expect.poll(() => app.io.sockets.sockets.size).toBe(2)
        await settle()

        // Bob saw carol arrive, and nothing else at all.
        expect(seen.map(([event, payload]) => [event, payload.username])).toEqual([['newLogin', 'carol']])
        expect(JSON.stringify(seen)).not.toContain(alice.userId)
        // No snapshot has her in it — not other people's, not the public one, not even her own.
        expect(bob.onlineUsers.map(user => user.username)).toEqual(['bob'])
        expect(carol.onlineUsers.map(user => user.username).sort()).toEqual(['bob', 'carol'])
        expect(again.onlineUsers.map(user => user.username)).toEqual(['bob'])
        expect(again.ownStatus).toMatchObject({ status: 'invisible', statusText: 'nobody should see this' })
        expect(JSON.stringify((await getJson(`${app.url}/online-users`)).body)).not.toContain('alice')
    })

    it('logs in unannounced, as the same nobody, on every later visit', async () => {
        const alice = await join(app, 'alice')
        await setStatus(alice.socket, { status: 'invisible' })
        alice.socket.close()
        await expect.poll(() => app.io.sockets.sockets.size).toBe(0)
        const bob = await join(app, 'bob')
        const seen = []
        bob.socket.onAny(event => seen.push(event))

        const again = await app.client()
        const session = await login(again, { username: 'alice', reservation: alice.reservation })
        await settle()

        expect(session.ownStatus.status).toBe('invisible')
        expect(seen).toEqual([])
        expect((await onlineUsers(app)).map(user => user.username)).toEqual(['bob'])
    })

    it('still sends and receives messages: they simply come from someone shown as offline', async () => {
        const alice = await join(app, 'alice')
        const bob = await join(app, 'bob')
        await setStatus(alice.socket, { status: 'invisible' })

        const toBob = nextEvent(bob.socket, 'message')
        expect((await send(alice.socket, messageTo(dm(alice, bob), 'I am here, quietly'))).ok).toBe(true)
        expect(await toBob).toMatchObject({ from: alice.userId, fromName: 'alice', text: 'I am here, quietly' })

        const toAlice = nextEvent(alice.socket, 'message')
        expect((await send(bob.socket, messageTo(dm(alice, bob), 'I thought you were away'))).ok).toBe(true)
        expect((await toAlice).text).toBe('I thought you were away')
        expect((await getHistory(alice.socket, { conversationId: dm(alice, bob) })).messages).toHaveLength(2)
        expect((await onlineUsers(app)).map(user => user.username)).toEqual(['bob'])
    })

    it('says nothing when an invisible guest becomes an account', async () => {
        const alice = await join(app, 'alice')
        await setStatus(alice.socket, { status: 'invisible' })
        const bob = await join(app, 'bob')
        const seen = []
        bob.socket.onAny(event => seen.push(event))

        expect((await register(alice.socket, 'alice')).ok).toBe(true)
        await settle()

        expect(seen).toEqual([])
    })
})

describe('a status text with a lifetime', () => {
    it('is answered with when it will clear, and has none once the text is empty', async () => {
        const alice = await join(app, 'alice')
        const before = Date.now()

        const timed = await setStatus(alice.socket, { text: 'at lunch', clearAfterMinutes: 30 })
        expect(timed.statusClearAt).toBeGreaterThanOrEqual(before + 30 * 60_000)
        expect(timed.statusClearAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000)
        expect((await Identity.findOne({ userId: alice.userId }).lean()).statusClearAt.getTime()).toBe(timed.statusClearAt)

        // A new lifetime for the same text; then for ever; and an empty text never has one.
        expect((await setStatus(alice.socket, { clearAfterMinutes: 60 })).statusClearAt).toBeGreaterThan(timed.statusClearAt)
        expect(await setStatus(alice.socket, { clearAfterMinutes: null })).toMatchObject({ statusText: 'at lunch', statusClearAt: null })
        expect(await setStatus(alice.socket, { text: '', clearAfterMinutes: 30 })).toMatchObject({ statusText: '', statusClearAt: null })
        // Changing only the status leaves the text's lifetime alone.
        await setStatus(alice.socket, { text: 'back at two', clearAfterMinutes: 30 })
        expect((await setStatus(alice.socket, { status: 'away' })).statusClearAt).toEqual(expect.any(Number))
    })

    it('clears itself when the time comes: for everyone watching, for the user’s devices, and in storage', async () => {
        const alice = await join(app, 'alice')
        const bob = await join(app, 'bob')
        // Only the server's timer is faked; everything else runs in real time.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        await setStatus(alice.socket, { status: 'dnd', text: 'at lunch', clearAfterMinutes: 30 })

        // Not a minute early…
        vi.advanceTimersByTime(29 * 60_000)
        expect(await shown('alice')).toMatchObject({ statusText: 'at lunch' })
        // …and no later than it said. (The listeners are set up only now, with real
        // timers: their own time-outs must not be swept along by the faked half hour.)
        vi.advanceTimersByTime(60_000)
        vi.useRealTimers()
        const cleared = nextEvent(bob.socket, 'presence')
        const told = nextEvent(alice.socket, 'ownStatus')

        // The text goes; the chosen status stays.
        expect(await cleared).toEqual({ userId: alice.userId, status: 'dnd', statusText: '' })
        expect(await told).toEqual({ status: 'dnd', statusText: '', statusClearAt: null })
        await expect.poll(async () => (await Identity.findOne({ userId: alice.userId }).lean()).statusText).toBe('')
        expect((await Identity.findOne({ userId: alice.userId }).lean()).statusClearAt).toBeNull()
    })

    it('does not fire for a text that was replaced, or for a user who has gone', async () => {
        const alice = await join(app, 'alice')
        const bob = await join(app, 'bob')
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        await setStatus(alice.socket, { text: 'first', clearAfterMinutes: 30 })
        await setStatus(alice.socket, { text: 'second' })
        const carol = await join(app, 'carol')
        await setStatus(carol.socket, { text: 'gone soon', clearAfterMinutes: 30 })
        vi.useRealTimers()
        carol.socket.close()
        await expect.poll(async () => (await onlineUsers(app)).length).toBe(2)
        const seen = record(bob.socket, 'presence')
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

        vi.advanceTimersByTime(60 * 60_000)
        vi.useRealTimers()
        await settle()

        expect(seen).toEqual([])
        expect(await shown('alice')).toMatchObject({ statusText: 'second' })
    })

    it('is already gone at login if its time ran out while the user was away, and is never announced', async () => {
        const alice = await join(app, 'alice')
        await setStatus(alice.socket, { status: 'away', text: 'back at two', clearAfterMinutes: 30 })
        alice.socket.close()
        await expect.poll(() => onlineUsers(app)).toEqual([])
        await Identity.updateOne({ userId: alice.userId }, { statusClearAt: new Date(Date.now() - 1000) })
        const bob = await join(app, 'bob')

        const seen = []
        bob.socket.onAny((event, payload) => seen.push([event, payload.statusText]))
        const announced = nextEvent(bob.socket, 'newLogin')
        const session = await login(await app.client(), { username: 'alice', reservation: alice.reservation })

        expect(await announced).toMatchObject({ username: 'alice', status: 'away', statusText: '' })
        // One announcement, already without the text: not the old text and then a correction.
        await settle()
        expect(seen).toEqual([['newLogin', '']])
        expect(session.ownStatus).toMatchObject({ status: 'away', statusText: '' })
        await expect.poll(async () => (await Identity.findOne({ userId: alice.userId }).lean()).statusText).toBe('')
    })
})

describe('the demo bot', () => {
    it('is always online, with a fixed text', async () => {
        await app.stop()
        app = await startApp({ demoBot: true })

        expect(await onlineUsers(app)).toEqual([
            { userId: 'demo-bot', username: 'demo-bot', kind: 'bot', status: 'online', statusText: BOT_STATUS_TEXT },
        ])
    })
})

describe('what a user is told about themself', () => {
    it('is only ever sent to them', async () => {
        const alice = await join(app, 'alice')
        await setStatus(alice.socket, { status: 'invisible', text: 'a private note to self' })

        const everythingBobWasSent = { ...await join(app, 'bob'), socket: undefined }

        expect(sortedKeys(alice.ownStatus)).toEqual(['status', 'statusClearAt', 'statusText'])
        expect(JSON.stringify(everythingBobWasSent)).not.toContain('a private note to self')
    })
})
