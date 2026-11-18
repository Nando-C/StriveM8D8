import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Identity } from '../src/models/identity.js'
import { Message } from '../src/models/message.js'
import { Session } from '../src/models/session.js'
import {
    PASSWORD, ask, connectTestDatabase, disconnectTestDatabase, dm, getHistory, join, login, messageTo, nextEvent,
    onlineUsers, record, register, send, settle, sortedKeys, startApp,
} from './helpers.js'

let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
beforeEach(async () => {
    app = await startApp()
})
afterEach(async () => {
    vi.restoreAllMocks()
    await app.stop()
    await Message.deleteMany({})
})

const WRONG = { ok: false, message: 'Wrong username or password' }
const ENDED = { ok: false, message: 'Your session has ended — sign in again', sessionEnded: true }

// Registers `username` and logs a new socket in with the session that came back.
const signUp = async (username, extra = {}) => {
    const socket = await app.client()
    const account = await register(socket, username, extra)
    const session = await login(socket, { session: account.session })
    return { socket, account, session }
}

// One more connection for an existing account.
const anotherDevice = async (username, extra = {}) => {
    const socket = await app.client()
    const session = await login(socket, { username, password: PASSWORD, ...extra })
    return { socket, session }
}

describe('creating an account', () => {
    it('returns a device session and a recovery code, once, and nothing else', async () => {
        const socket = await app.client()

        const account = await register(socket, 'alice')

        expect(sortedKeys(account)).toEqual(['admin', 'kind', 'ok', 'recoveryCode', 'session'])
        expect(account).toMatchObject({ ok: true, kind: 'account', admin: false })
        expect(account.recoveryCode).toMatch(/^([A-Z2-9]{5}-){3}[A-Z2-9]{5}$/)
        // Registering does not put anyone online: the client logs in with the session next.
        expect(await onlineUsers(app)).toEqual([])
    })

    it('stores neither the password, the session nor the recovery code', async () => {
        const socket = await app.client()

        const account = await register(socket, 'alice')

        const stored = JSON.stringify([await Identity.find().lean(), await Session.find().lean()])
        expect(stored).not.toContain(PASSWORD)
        expect(stored).not.toContain(account.session)
        expect(stored).not.toContain(account.recoveryCode)
        expect(stored).not.toContain(account.recoveryCode.replaceAll('-', ''))
    })

    it.each([
        ['an invalid username', { username: 'two words', password: PASSWORD }, 'Invalid username'],
        ['a missing username', { password: PASSWORD }, 'Invalid username'],
        ['a short password', { username: 'alice', password: '1234567' }, 'Password must be 8 to 128 characters'],
        ['a huge password', { username: 'alice', password: 'x'.repeat(129) }, 'Password must be 8 to 128 characters'],
        ['a password that is not text', { username: 'alice', password: { $ne: '' } }, 'Password must be 8 to 128 characters'],
        ['the bot’s name', { username: 'demo-bot', password: PASSWORD }, 'Username already in use'],
    ])('refuses %s', async (_label, payload, message) => {
        const socket = await app.client()

        expect(await ask(socket, 'register', payload)).toEqual({ ok: false, message })
        expect(await Identity.countDocuments()).toBe(0)
    })

    it('refuses a name that an account or a guest already holds', async () => {
        await signUp('alice')
        const guest = await app.client()
        await login(guest, { username: 'bob' })
        const socket = await app.client()

        expect(await register(socket, 'alice')).toEqual({ ok: false, message: 'Username already in use' })
        expect(await register(socket, 'bob')).toEqual({ ok: false, message: 'Username already in use' })
        expect(await register(socket, 'bob', { reservation: 'not-the-secret' }))
            .toEqual({ ok: false, message: 'Username already in use' })
    })

    it('gives the name to exactly one of two people who ask at the same moment', async () => {
        const first = await app.client()
        const second = await app.client()

        const answers = await Promise.all([register(first, 'alice'), register(second, 'alice')])

        expect(answers.filter(answer => answer.ok)).toHaveLength(1)
        expect(answers.find(answer => !answer.ok)).toEqual({ ok: false, message: 'Username already in use' })
        expect(await Identity.countDocuments({ username: 'alice' })).toBe(1)
    })

    it('does not let a socket that is already somebody register another name', async () => {
        const { socket } = await signUp('alice')

        expect(await register(socket, 'zed')).toEqual({ ok: false, message: 'Already logged in' })
    })

    it('limits sign-ups per client address', async () => {
        await app.stop()
        app = await startApp({ limits: { registrationsPerAddress: { limit: 2, windowMs: 60_000 } } })

        const answers = []
        for (const name of ['a', 'b', 'c']) answers.push(await register(await app.client(), name))

        expect(answers.map(answer => answer.ok)).toEqual([true, true, false])
        expect(answers[2].message).toBe('Too many sign-ups from this network, try again later')
    })

    it('hashes at most two passwords at a time, however many people sign up at once', async () => {
        const sockets = await Promise.all(Array.from({ length: 6 }, () => app.client()))

        const answers = await Promise.all(sockets.map((socket, index) => register(socket, `user-${index}`)))

        expect(answers.every(answer => answer.ok)).toBe(true)
        expect(app.hasherStats().peak).toBe(2)
    })
})

describe('signing in', () => {
    it('logs in with the session from sign-up, as an account', async () => {
        const { socket, session } = await signUp('alice')

        expect(sortedKeys(session)).toEqual(['admin', 'conversations', 'kind', 'ok', 'onlineUsers', 'sessionToken', 'userId', 'username'])
        expect(session).toMatchObject({ ok: true, username: 'alice', kind: 'account', admin: false })
        expect(await onlineUsers(app)).toEqual([{ userId: session.userId, username: 'alice', kind: 'account' }])
        expect(JSON.stringify(session)).not.toContain(socket.id)
    })

    it('logs in with the password from another device, which gets a session of its own', async () => {
        const { account } = await signUp('alice')

        const { session } = await anotherDevice('alice', { deviceLabel: '  Firefox on Linux\n' })

        expect(session.ok).toBe(true)
        expect(session.session).toEqual(expect.any(String))
        expect(session.session).not.toBe(account.session)
        expect((await Session.find().lean()).map(doc => doc.label).sort()).toEqual(['', 'Firefox on Linux'])
    })

    it('gives a wrong password and an unknown account the same answer', async () => {
        await signUp('alice')
        const guest = await app.client()
        await login(guest, { username: 'guest-name' })
        const socket = await app.client()

        expect(await login(socket, { username: 'alice', password: 'not the password' })).toEqual(WRONG)
        expect(await login(socket, { username: 'nobody', password: PASSWORD })).toEqual(WRONG)
        // A guest's name has no password either.
        expect(await login(socket, { username: 'guest-name', password: PASSWORD })).toEqual(WRONG)
        expect(await login(socket, { username: 'alice', password: { $ne: '' } })).toEqual(WRONG)
    })

    it('does not let anyone use an account’s name as a guest', async () => {
        const { account } = await signUp('alice')
        const socket = await app.client()

        expect(await login(socket, { username: 'alice' }))
            .toEqual({ ok: false, message: 'That name belongs to an account — sign in' })
        expect(await login(socket, { username: 'alice', reservation: account.session }))
            .toEqual({ ok: false, message: 'That name belongs to an account — sign in' })
    })

    it('refuses a session it does not know', async () => {
        await signUp('alice')
        const socket = await app.client()

        expect(await login(socket, { session: 'made-up' })).toEqual(ENDED)
        expect(await login(socket, { session: '' })).toEqual(ENDED)
        expect(await login(socket, { session: { $ne: '' } })).toEqual(ENDED)
    })

    it('slows down guessing from one address, and does not hold up anyone else', async () => {
        await app.stop()
        app = await startApp({ trustedProxyHops: 1 })
        await register(await app.client({ address: '198.51.100.1' }), 'alice')
        const attacker = () => app.client({ address: '203.0.113.50' })

        // Five wrong guesses, on fresh sockets so the per-socket limit is not what stops them.
        for (let index = 0; index < 5; index++) {
            expect(await login(await attacker(), { username: 'alice', password: `guess number ${index}` })).toEqual(WRONG)
        }
        const blocked = await login(await attacker(), { username: 'alice', password: PASSWORD })

        expect(blocked.ok).toBe(false)
        expect(blocked.message).toMatch(/^Too many attempts\. Try again in \d+ s$/)
        expect(blocked.retryAfterMs).toBeGreaterThan(0)
        // A forged header in front of the proxy's entry does not get around it.
        const forging = await app.client({ address: '8.8.8.8, 203.0.113.50' })
        expect((await login(forging, { username: 'alice', password: PASSWORD })).ok).toBe(false)

        // There is no lock on the name itself: the owner, elsewhere, signs in at once.
        const owner = await app.client({ address: '198.51.100.1' })
        expect((await login(owner, { username: 'alice', password: PASSWORD })).ok).toBe(true)
        // Nor on the attacker's address for other names.
        await register(await app.client({ address: '198.51.100.1' }), 'bob')
        expect((await login(await attacker(), { username: 'bob', password: PASSWORD })).ok).toBe(true)
    })
})

describe('several devices on one account', () => {
    it('announces the user once, and says they left only when the last device goes — in whatever order they go', async () => {
        const watcher = await join(app, 'watcher')
        const joins = record(watcher.socket, 'newLogin')
        const leaves = record(watcher.socket, 'userLeft')

        const first = await signUp('alice')
        const second = await anotherDevice('alice')
        const alice = { userId: first.session.userId, username: 'alice', kind: 'account' }

        expect(second.session.userId).toBe(first.session.userId)
        expect(second.session.onlineUsers).toEqual([{ userId: watcher.userId, username: 'watcher', kind: 'guest' }, alice])

        // The device that connected first goes first: nothing changes for anyone else.
        first.socket.close()
        await expect.poll(() => app.io.sockets.sockets.has(first.socket.id)).toBe(false)
        const third = await anotherDevice('alice')
        third.socket.close()
        await expect.poll(() => app.io.sockets.sockets.has(third.socket.id)).toBe(false)
        await settle()
        expect(joins).toEqual([alice])
        expect(leaves).toEqual([])
        expect(await onlineUsers(app)).toContainEqual(alice)

        const left = nextEvent(watcher.socket, 'userLeft')
        second.socket.close()

        expect(await left).toEqual({ userId: alice.userId })
        await settle()
        expect(leaves).toHaveLength(1)
        expect(joins).toHaveLength(1)
    })

    it('cannot be used to message yourself from one device to another', async () => {
        const first = await signUp('alice')
        const second = await anotherDevice('alice')
        const id = first.session.userId

        expect(await send(second.socket, messageTo(`dm:${id}::${id}`)))
            .toEqual({ ok: false, message: 'Unknown conversation' })
    })

    it('admits five connections and refuses a sixth, unless it replaces one of them', async () => {
        const first = await signUp('alice')
        const devices = [first]
        for (let index = 0; index < 4; index++) devices.push(await anotherDevice('alice'))

        const sixth = await app.client()
        expect(await login(sixth, { session: first.account.session }))
            .toEqual({ ok: false, message: 'Too many devices connected at once' })

        // A device coming back names the connection it had, and takes its place.
        const stale = devices[4]
        const closed = nextEvent(stale.socket, 'disconnect')
        const back = await login(sixth, { session: stale.session.session, sessionToken: stale.session.sessionToken })

        expect(back.ok).toBe(true)
        expect(await closed).toBe('io server disconnect')
        expect(await onlineUsers(app)).toHaveLength(1)
    })

    it('does not honour another user’s connection token', async () => {
        const alice = await signUp('alice')
        const bob = await signUp('bob')
        const kicked = record(alice.socket, 'disconnect')

        const socket = await app.client()
        const reply = await login(socket, { session: bob.account.session, sessionToken: alice.session.sessionToken })

        expect(reply).toMatchObject({ ok: true, username: 'bob' })
        await settle()
        expect(kicked).toEqual([])
    })
})

describe('devices', () => {
    it('lists the account’s sessions, marking the one asking', async () => {
        const first = await signUp('alice')
        await anotherDevice('alice', { deviceLabel: 'Phone' })

        const reply = await ask(first.socket, 'listSessions')

        expect(reply.ok).toBe(true)
        expect(reply.sessions).toHaveLength(2)
        expect(reply.sessions.map(session => sortedKeys(session)))
            .toEqual(Array(2).fill(['createdAt', 'current', 'id', 'label', 'lastUsedAt']))
        expect(reply.sessions.filter(session => session.current)).toHaveLength(1)
        expect(reply.sessions.find(session => !session.current).label).toBe('Phone')
    })

    it('disconnects a device the moment its session is revoked, and it cannot come back', async () => {
        const first = await signUp('alice')
        const second = await anotherDevice('alice')
        const { sessions } = await ask(first.socket, 'listSessions')
        const other = sessions.find(session => !session.current)

        const told = nextEvent(second.socket, 'sessionRevoked')
        const closed = nextEvent(second.socket, 'disconnect')
        expect(await ask(first.socket, 'revokeSession', { id: other.id })).toEqual({ ok: true })

        expect(await told).toEqual({ reason: 'Signed out from another device' })
        expect(await closed).toBe('io server disconnect')
        const retry = await app.client()
        expect(await login(retry, { session: second.session.session })).toEqual(ENDED)
        // The connection token it held is worth nothing either.
        expect(await login(retry, { username: 'alice', sessionToken: second.session.sessionToken }))
            .toEqual({ ok: false, message: 'That name belongs to an account — sign in' })
        // The device that did the revoking is untouched.
        expect((await ask(first.socket, 'listSessions')).sessions).toHaveLength(1)
    })

    it('cannot revoke another account’s session, or one that does not exist', async () => {
        const alice = await signUp('alice')
        const bob = await signUp('bob')
        const bobSessionId = (await ask(bob.socket, 'listSessions')).sessions[0].id

        for (const id of [bobSessionId, 'ffffffffffffffffffffffff', 'nonsense', { $ne: null }, undefined]) {
            expect(await ask(alice.socket, 'revokeSession', { id })).toEqual({ ok: false, message: 'Unknown device' })
        }
        expect((await ask(bob.socket, 'listSessions')).sessions).toHaveLength(1)
    })

    it('logs out this device only: the connection stays, logged out, and the session is gone', async () => {
        const first = await signUp('alice')
        const second = await anotherDevice('alice')
        const closed = record(first.socket, 'disconnect')

        expect(await ask(first.socket, 'logout')).toEqual({ ok: true })

        expect(await send(first.socket, messageTo('dm:a::b'))).toEqual({ ok: false, message: 'Not logged in' })
        expect(await ask(first.socket, 'listSessions')).toEqual({ ok: false, message: 'Not logged in' })
        expect(await login(await app.client(), { session: first.account.session })).toEqual(ENDED)
        await settle()
        expect(closed).toEqual([])
        expect((await onlineUsers(app)).map(user => user.username)).toEqual(['alice'])
        expect(app.io.sockets.sockets.has(second.socket.id)).toBe(true)
        // The same connection can be used to sign in again.
        expect((await login(first.socket, { username: 'alice', password: PASSWORD })).ok).toBe(true)
    })

    it('closes other tabs that share the session when one of them logs out', async () => {
        const first = await signUp('alice')
        const tab = await app.client()
        await login(tab, { session: first.account.session })

        const told = nextEvent(tab, 'sessionRevoked')
        await ask(first.socket, 'logout')

        expect(await told).toEqual({ reason: 'Signed out' })
        await expect.poll(() => onlineUsers(app)).toEqual([])
    })

    it('lets a guest log out too, keeping the name reserved', async () => {
        const guest = await app.client()
        const { reservation } = await login(guest, { username: 'guest-name' })

        expect(await ask(guest, 'logout')).toEqual({ ok: true })

        expect(await onlineUsers(app)).toEqual([])
        expect((await login(guest, { username: 'guest-name', reservation })).ok).toBe(true)
    })

    it('keeps account-only actions from guests and from sockets that are nobody', async () => {
        const guest = await app.client()
        await login(guest, { username: 'guest-name' })
        const nobody = await app.client()

        for (const event of ['listSessions', 'revokeSession', 'changePassword', 'deleteAccount']) {
            expect(await ask(guest, event)).toEqual({ ok: false, message: 'Only for accounts' })
            expect(await ask(nobody, event)).toEqual({ ok: false, message: 'Not logged in' })
        }
        expect(await ask(nobody, 'logout')).toEqual({ ok: false, message: 'Not logged in' })
    })
})

describe('changing the password', () => {
    it('needs the current one, signs every other device out, and keeps this one', async () => {
        const first = await signUp('alice')
        const second = await anotherDevice('alice')

        expect(await ask(first.socket, 'changePassword', { currentPassword: 'not it at all', newPassword: 'a brand new password' }))
            .toEqual({ ok: false, message: 'Wrong password' })
        expect(await ask(first.socket, 'changePassword', { currentPassword: PASSWORD, newPassword: 'short' }))
            .toEqual({ ok: false, message: 'Password must be 8 to 128 characters' })

        const told = nextEvent(second.socket, 'sessionRevoked')
        const closed = nextEvent(second.socket, 'disconnect')
        expect(await ask(first.socket, 'changePassword', { currentPassword: PASSWORD, newPassword: 'a brand new password' }))
            .toEqual({ ok: true })

        expect(await told).toEqual({ reason: 'The password was changed' })
        await closed
        expect(await login(await app.client(), { session: second.session.session })).toEqual(ENDED)
        expect(await login(await app.client(), { username: 'alice', password: PASSWORD })).toEqual(WRONG)
        expect((await login(await app.client(), { username: 'alice', password: 'a brand new password' })).ok).toBe(true)
        // This device was not disconnected and its session still works.
        expect((await ask(first.socket, 'listSessions')).ok).toBe(true)
        expect((await login(await app.client(), { session: first.account.session })).ok).toBe(true)
    })
})

describe('recovering an account', () => {
    it('sets a new password with the recovery code, replaces the code, and signs everything out', async () => {
        const first = await signUp('alice')
        const typed = ` ${first.account.recoveryCode.toLowerCase().replaceAll('-', ' ')} `
        const stranger = await app.client()

        const told = nextEvent(first.socket, 'sessionRevoked')
        const closed = nextEvent(first.socket, 'disconnect')
        const reply = await ask(stranger, 'resetPassword', { username: 'alice', recoveryCode: typed, newPassword: 'the replacement one' })

        expect(sortedKeys(reply)).toEqual(['ok', 'recoveryCode'])
        expect(reply.recoveryCode).not.toBe(first.account.recoveryCode)
        expect(await told).toEqual({ reason: 'The password was reset' })
        await closed
        expect(await onlineUsers(app)).toEqual([])
        expect(await login(await app.client(), { session: first.account.session })).toEqual(ENDED)
        expect(await login(await app.client(), { username: 'alice', password: PASSWORD })).toEqual(WRONG)
        expect((await login(await app.client(), { username: 'alice', password: 'the replacement one' })).ok).toBe(true)

        // The old code was used up; the new one works.
        const again = { username: 'alice', newPassword: 'yet another password' }
        expect(await ask(stranger, 'resetPassword', { ...again, recoveryCode: first.account.recoveryCode }))
            .toEqual({ ok: false, message: 'Wrong username or recovery code' })
        expect((await ask(stranger, 'resetPassword', { ...again, recoveryCode: reply.recoveryCode })).ok).toBe(true)
    })

    it('answers a wrong code and an unknown account alike, and counts both as guesses', async () => {
        await signUp('alice')
        const wrong = { ok: false, message: 'Wrong username or recovery code' }

        expect(await ask(await app.client(), 'resetPassword', { username: 'alice', recoveryCode: 'AAAAA-AAAAA-AAAAA-AAAAA', newPassword: PASSWORD }))
            .toEqual(wrong)
        expect(await ask(await app.client(), 'resetPassword', { username: 'nobody', recoveryCode: 'AAAAA-AAAAA-AAAAA-AAAAA', newPassword: PASSWORD }))
            .toEqual(wrong)
        expect(await ask(await app.client(), 'resetPassword', { username: 'alice', recoveryCode: { $ne: '' }, newPassword: PASSWORD }))
            .toEqual(wrong)

        for (let index = 0; index < 4; index++) {
            await ask(await app.client(), 'resetPassword', { username: 'alice', recoveryCode: `guess-${index}`, newPassword: PASSWORD })
        }
        const blocked = await ask(await app.client(), 'resetPassword', { username: 'alice', recoveryCode: 'one more', newPassword: PASSWORD })
        expect(blocked.message).toMatch(/^Too many attempts/)
    })
})

describe('deleting an account', () => {
    it('needs the password, removes everything, disconnects every device, and frees the name for a new identity', async () => {
        const first = await signUp('alice')
        const second = await anotherDevice('alice')
        const { userId } = await Identity.findOne({ username: 'alice' }).lean()

        expect(await ask(first.socket, 'deleteAccount', { password: 'not the password' }))
            .toEqual({ ok: false, message: 'Wrong password' })
        expect(await Identity.countDocuments()).toBe(1)

        const told = nextEvent(second.socket, 'sessionRevoked')
        const closed = nextEvent(second.socket, 'disconnect')
        expect(await ask(first.socket, 'deleteAccount', { password: PASSWORD })).toEqual({ ok: true })

        expect(await told).toEqual({ reason: 'The account was deleted' })
        await closed
        expect(await Identity.countDocuments()).toBe(0)
        expect(await Session.countDocuments()).toBe(0)
        expect(await onlineUsers(app)).toEqual([])
        expect(await login(await app.client(), { session: first.account.session })).toEqual(ENDED)
        expect(await login(await app.client(), { username: 'alice', password: PASSWORD })).toEqual(WRONG)

        // Whoever takes the name next is a different identity.
        const next = await signUp('alice')
        expect(next.session.ok).toBe(true)
        expect((await Identity.findOne({ username: 'alice' }).lean()).userId).not.toBe(userId)
    })
})

describe('turning a guest into an account', () => {
    it('keeps the identity and its conversations, from the guest’s own connection', async () => {
        const bob = await join(app, 'bob')
        const { socket: guest, userId, ...alice } = await join(app, 'alice')
        expect(alice.kind).toBe('guest')
        await send(guest, messageTo(dm(userId, bob), 'sent as a guest'))
        const seenByBob = record(bob.socket, 'userLeft')
        const relisted = nextEvent(bob.socket, 'newLogin')

        const account = await register(guest, 'alice')

        // Everyone's entry for her now says she is an account; she never left.
        expect(await relisted).toEqual({ userId, username: 'alice', kind: 'account' })

        expect(account).toMatchObject({ ok: true, kind: 'account' })
        const stored = await Identity.findOne({ username: 'alice' }).lean()
        expect(stored).toMatchObject({ userId, kind: 'account' })
        expect(stored.secretHash).toBeUndefined()
        // Still logged in, now as an account with a device session of its own.
        expect((await ask(guest, 'listSessions')).sessions).toEqual([expect.objectContaining({ current: true })])
        expect((await getHistory(guest, { conversationId: dm(userId, bob) })).messages.map(message => message.text))
            .toEqual(['sent as a guest'])
        // The same identity, so the same conversations, on any device that signs in.
        const elsewhere = await login(await app.client(), { username: 'alice', password: PASSWORD })
        expect(elsewhere.conversations.map(conversation => conversation.id)).toEqual([dm(userId, bob)])
        await settle()
        expect(seenByBob).toEqual([])
        // And from now on, from any device, with the password or the session.
        expect((await anotherDevice('alice')).session.ok).toBe(true)
        expect((await login(await app.client(), { session: account.session })).ok).toBe(true)
    })

    it('works from a fresh connection with the reservation, which is then spent', async () => {
        const guest = await app.client()
        const { reservation } = await login(guest, { username: 'alice' })
        const told = nextEvent(guest, 'sessionRevoked')

        const account = await register(await app.client(), 'alice', { reservation })

        expect(account.ok).toBe(true)
        // The connection that was a guest has to sign in again, as the account.
        expect(await told).toEqual({ reason: 'This name is now an account — sign in' })
        expect(await login(await app.client(), { username: 'alice', reservation }))
            .toEqual({ ok: false, message: 'That name belongs to an account — sign in' })
    })
})

describe('what other people can see', () => {
    it('never includes a password, a hash, a session, a reservation or a recovery code — in events, REST or logs', async () => {
        const logged = []
        for (const method of ['log', 'warn', 'error', 'info']) {
            vi.spyOn(console, method).mockImplementation((...args) => logged.push(args))
        }
        const watcher = await app.client()
        const watcherSession = await login(watcher, { username: 'watcher' })
        const seen = []
        watcher.onAny((event, ...args) => seen.push([event, ...args]))

        // Everything an account can do, while the watcher looks on.
        const first = await signUp('alice')
        const second = await anotherDevice('alice')
        // (A conversation with the watcher, so that account activity has somewhere to leak to.)
        await send(first.socket, messageTo(dm(first.session, watcherSession), 'hello watcher'))
        await login(await app.client(), { username: 'alice', password: 'a wrong password' })
        await ask(first.socket, 'listSessions')
        const newPassword = 'a brand new password'
        await ask(first.socket, 'changePassword', { currentPassword: PASSWORD, newPassword })
        const reset = await ask(await app.client(), 'resetPassword', {
            username: 'alice', recoveryCode: first.account.recoveryCode, newPassword: 'the replacement one',
        })
        const guest = await app.client()
        const guestSession = await login(guest, { username: 'guest-name' })
        const upgraded = await register(guest, 'guest-name')
        const stored = await Identity.find().lean()
        await settle()

        const secrets = [
            PASSWORD, newPassword, 'the replacement one', 'a wrong password',
            first.account.session, first.account.recoveryCode, first.session.sessionToken,
            second.session.session, second.session.sessionToken,
            reset.recoveryCode, guestSession.reservation, guestSession.sessionToken,
            upgraded.session, upgraded.recoveryCode, watcherSession.reservation,
            ...stored.flatMap(identity => [identity.passwordHash, identity.recoveryHash, identity.secretHash]),
            ...(await Session.find().lean()).map(session => session.tokenHash),
        ].filter(Boolean)
        expect(secrets.length).toBeGreaterThan(15)

        const visible = JSON.stringify([seen, await onlineUsers(app)])
        const logs = JSON.stringify(logged)
        for (const secret of secrets) {
            expect(visible).not.toContain(secret)
            // The watcher's own reservation is legitimately theirs; it must still not be logged.
            expect(logs).not.toContain(secret)
        }
        expect(seen.length).toBeGreaterThan(0)
        expect(visible).not.toMatch(/sessionToken|reservation|recoveryCode|passwordHash|"session"/)
        // Nor does anything say which connection anyone is on.
        for (const socket of [first.socket, second.socket, guest]) expect(visible).not.toContain(socket.id ?? 'no-id')
    })
})
