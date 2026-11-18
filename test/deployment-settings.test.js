import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Identity } from '../src/models/identity.js'
import { Invitation } from '../src/models/invitation.js'
import {
    PASSWORD, ask, connectTestDatabase, disconnectTestDatabase, getJson, login, nextEvent, onlineUsers,
    register, sortedKeys, startApp,
} from './helpers.js'

// The same code as two deployments: the public demo (every default) and a private one
// (sign-up by invitation, no guests). Each test starts the configuration it is about.
let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
afterEach(() => app.stop())

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const BOOTSTRAP = 'the-owners-bootstrap-code'
const PRIVATE = { signupMode: 'invite', guests: false, adminUsernames: ['owner'], bootstrapCode: BOOTSTRAP }
const RESERVED = { ok: false, message: 'That name is reserved' }

// Registers the owner with the bootstrap code and logs a socket in as them.
const ownerSocket = async () => {
    const socket = await app.client()
    const account = await register(socket, 'owner', { bootstrapCode: BOOTSTRAP })
    const session = await login(socket, { session: account.session })
    return { socket, account, session }
}

describe('GET /config', () => {
    it('describes the public demo by default', async () => {
        app = await startApp()

        const response = await getJson(`${app.url}/config`)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ signup: 'open', guests: true, protocol: 1 })
    })

    it('describes a private deployment, with modes only: no names, no codes', async () => {
        app = await startApp(PRIVATE)

        const response = await getJson(`${app.url}/config`)

        expect(response.body).toEqual({ signup: 'invite', guests: false, protocol: 1 })
        expect(JSON.stringify(response.body)).not.toMatch(/owner|bootstrap/i)
    })
})

describe('with guests switched off', () => {
    it('refuses a name without an account, and tells nobody outside who is online', async () => {
        app = await startApp(PRIVATE)
        const { socket } = await ownerSocket()
        const visitor = await app.client()

        expect(await login(visitor, { username: 'visitor' }))
            .toEqual({ ok: false, message: 'Guest access is off — sign in with an account' })
        expect(await Identity.countDocuments({ kind: 'guest' })).toBe(0)

        const response = await getJson(`${app.url}/online-users`)
        expect(response.status).toBe(404)
        expect(JSON.stringify(response.body)).not.toContain('owner')
        // Members still get presence, over their socket.
        expect((await login(socket, { username: 'owner' })).onlineUsers).toEqual([{ username: 'owner', id: socket.id }])
    })
})

describe('sign-up by invitation', () => {
    it('refuses registration without an invitation, or with a made-up one', async () => {
        app = await startApp(PRIVATE)
        const socket = await app.client()

        expect(await register(socket, 'ana'))
            .toEqual({ ok: false, message: 'An invitation is needed to sign up' })
        expect(await register(socket, 'ana', { invitation: 'made-up' }))
            .toEqual({ ok: false, message: 'That invitation is not valid any more' })
        expect(await register(socket, 'ana', { invitation: { $ne: '' } }))
            .toEqual({ ok: false, message: 'An invitation is needed to sign up' })
        // The bootstrap code is for the reserved names only.
        expect(await register(socket, 'ana', { bootstrapCode: BOOTSTRAP }))
            .toEqual({ ok: false, message: 'An invitation is needed to sign up' })
        expect(await Identity.countDocuments()).toBe(0)
    })

    it('lets an administrator invite someone, once per invitation', async () => {
        app = await startApp(PRIVATE)
        const owner = await ownerSocket()
        expect(owner.session.admin).toBe(true)

        const invitation = await ask(owner.socket, 'createInvitation')

        expect(sortedKeys(invitation)).toEqual(['code', 'expiresAt', 'id', 'ok'])
        expect(invitation.expiresAt - Date.now()).toBeGreaterThan(7 * DAY - 60_000)
        expect(invitation.expiresAt - Date.now()).toBeLessThanOrEqual(7 * DAY)
        // Only a fingerprint of the code is stored.
        expect(JSON.stringify(await Invitation.find().lean())).not.toContain(invitation.code)

        const ana = await register(await app.client(), 'ana', { invitation: invitation.code })
        expect(ana).toMatchObject({ ok: true, admin: false })
        expect(await register(await app.client(), 'ben', { invitation: invitation.code }))
            .toEqual({ ok: false, message: 'That invitation is not valid any more' })
        expect(await Invitation.countDocuments()).toBe(0)
    })

    it('gives one invitation to exactly one of two people who use it at the same moment', async () => {
        app = await startApp(PRIVATE)
        const owner = await ownerSocket()
        const { code } = await ask(owner.socket, 'createInvitation')
        const [first, second] = [await app.client(), await app.client()]

        const answers = await Promise.all([
            register(first, 'ana', { invitation: code }), register(second, 'ben', { invitation: code }),
        ])

        expect(answers.filter(answer => answer.ok)).toHaveLength(1)
        expect(await Identity.countDocuments({ username: { $in: ['ana', 'ben'] } })).toBe(1)
    })

    it('does not spend the invitation when the name turns out to be taken', async () => {
        app = await startApp(PRIVATE)
        const owner = await ownerSocket()
        const { code } = await ask(owner.socket, 'createInvitation')

        expect(await register(await app.client(), 'owner', { invitation: code })).toEqual(RESERVED)
        expect(await register(await app.client(), 'two words', { invitation: code }))
            .toEqual({ ok: false, message: 'Invalid username' })

        expect((await register(await app.client(), 'ana', { invitation: code })).ok).toBe(true)
    })

    it('refuses an invitation that has expired, even before the database has removed it', async () => {
        app = await startApp(PRIVATE)
        const owner = await ownerSocket()
        const { code, id } = await ask(owner.socket, 'createInvitation')
        await Invitation.updateOne({ _id: id }, { expiresAt: new Date(Date.now() - 1000) })

        expect(await register(await app.client(), 'ana', { invitation: code }))
            .toEqual({ ok: false, message: 'That invitation is not valid any more' })
        expect((await ask(owner.socket, 'listInvitations')).invitations).toEqual([])
    })

    it('lets an administrator list and revoke unused invitations, without showing the codes again', async () => {
        app = await startApp(PRIVATE)
        const owner = await ownerSocket()
        const first = await ask(owner.socket, 'createInvitation')
        const second = await ask(owner.socket, 'createInvitation')

        const listed = await ask(owner.socket, 'listInvitations')
        expect(listed.invitations.map(invitation => invitation.id).sort()).toEqual([first.id, second.id].sort())
        expect(sortedKeys(listed.invitations[0])).toEqual(['createdAt', 'expiresAt', 'id'])

        expect(await ask(owner.socket, 'revokeInvitation', { id: first.id })).toEqual({ ok: true })
        for (const id of [first.id, 'nonsense', { $ne: null }]) {
            expect(await ask(owner.socket, 'revokeInvitation', { id })).toEqual({ ok: false, message: 'Unknown invitation' })
        }
        expect(await register(await app.client(), 'ana', { invitation: first.code }))
            .toEqual({ ok: false, message: 'That invitation is not valid any more' })
        expect((await register(await app.client(), 'ana', { invitation: second.code })).ok).toBe(true)
    })

    it('keeps invitations to administrators', async () => {
        app = await startApp({ ...PRIVATE, guests: true })
        const owner = await ownerSocket()
        const { code } = await ask(owner.socket, 'createInvitation')
        const member = await app.client()
        const account = await register(member, 'ana', { invitation: code })
        await login(member, { session: account.session })
        const guest = await app.client()
        await login(guest, { username: 'guest-name' })
        const nobody = await app.client()

        for (const event of ['createInvitation', 'listInvitations', 'revokeInvitation']) {
            expect(await ask(member, event)).toEqual({ ok: false, message: 'Only for administrators' })
            expect(await ask(guest, event)).toEqual({ ok: false, message: 'Only for accounts' })
            expect(await ask(nobody, event)).toEqual({ ok: false, message: 'Not logged in' })
        }
    })

    it('still asks a guest for an invitation before turning them into an account', async () => {
        app = await startApp({ ...PRIVATE, guests: true })
        const guest = await app.client()
        await login(guest, { username: 'guest-name' })

        expect(await register(guest, 'guest-name'))
            .toEqual({ ok: false, message: 'An invitation is needed to sign up' })
    })
})

describe('sign-up closed', () => {
    it('refuses every registration, the owner’s included', async () => {
        app = await startApp({ ...PRIVATE, signupMode: 'closed' })
        const socket = await app.client()

        expect(await register(socket, 'ana')).toEqual({ ok: false, message: 'Sign-up is closed' })
        expect(await register(socket, 'owner', { bootstrapCode: BOOTSTRAP })).toEqual({ ok: false, message: 'Sign-up is closed' })
        expect((await getJson(`${app.url}/config`)).body.signup).toBe('closed')
    })
})

describe('administrator names', () => {
    it('are registered with the bootstrap code, as administrators, once', async () => {
        app = await startApp(PRIVATE)

        const owner = await ownerSocket()

        expect(owner.account).toMatchObject({ ok: true, admin: true })
        expect(owner.session).toMatchObject({ kind: 'account', admin: true })
        expect(await register(await app.client(), 'owner', { bootstrapCode: BOOTSTRAP }))
            .toEqual({ ok: false, message: 'Username already in use' })
    })

    // The four ways someone else might try to take a listed name that is still free.
    it('cannot be registered without the code, in any sign-up mode', async () => {
        app = await startApp({ ...PRIVATE, signupMode: 'open', guests: true })
        const socket = await app.client()

        expect(await register(socket, 'owner')).toEqual(RESERVED)
        expect(await register(socket, 'owner', { bootstrapCode: 'a guess' })).toEqual(RESERVED)
        expect(await register(socket, 'owner', { bootstrapCode: { $ne: '' } })).toEqual(RESERVED)
    })

    it('cannot be registered with an invitation', async () => {
        app = await startApp({ ...PRIVATE, adminUsernames: ['owner', 'second-owner'] })
        const owner = await ownerSocket()
        const { code } = await ask(owner.socket, 'createInvitation')

        expect(await register(await app.client(), 'second-owner', { invitation: code })).toEqual(RESERVED)
    })

    it('cannot be used as a guest name', async () => {
        app = await startApp({ ...PRIVATE, guests: true })

        expect(await login(await app.client(), { username: 'owner' })).toEqual(RESERVED)
        expect(await Identity.countDocuments()).toBe(0)
    })

    it('cannot be reached by upgrading a guest who held the name before it was listed', async () => {
        // The guest took the name on a deployment that did not list it yet.
        app = await startApp()
        const guest = await app.client()
        const { reservation } = await login(guest, { username: 'owner' })
        const kept = await Identity.findOne({ username: 'owner' }).lean()
        await app.stop()
        await Identity.create(kept)

        app = await startApp({ ...PRIVATE, signupMode: 'open', guests: true })
        const socket = await app.client()

        expect(await login(socket, { username: 'owner', reservation })).toEqual(RESERVED)
        expect(await register(socket, 'owner', { reservation })).toEqual(RESERVED)
        // Not even with the code: the name is taken, and a guest is never promoted to administrator.
        expect(await register(socket, 'owner', { reservation, bootstrapCode: BOOTSTRAP }))
            .toEqual({ ok: false, message: 'Username already in use' })
        expect((await Identity.findOne({ username: 'owner' }).lean()).kind).toBe('guest')
    })

    it('cannot be registered at all while no bootstrap code is set', async () => {
        app = await startApp({ ...PRIVATE, bootstrapCode: null })
        const socket = await app.client()

        expect(await register(socket, 'owner')).toEqual(RESERVED)
        expect(await register(socket, 'owner', { bootstrapCode: '' })).toEqual(RESERVED)
        expect(await register(socket, 'owner', { bootstrapCode: null })).toEqual(RESERVED)
        expect(await register(socket, 'owner', { bootstrapCode: 'undefined' })).toEqual(RESERVED)
    })

    it('do not make an administrator of an ordinary account that already had the name', async () => {
        app = await startApp()
        const account = await register(await app.client(), 'owner')
        const kept = await Identity.findOne({ username: 'owner' }).lean()
        await app.stop()
        await Identity.create(kept)

        app = await startApp(PRIVATE)
        const socket = await app.client()
        const session = await login(socket, { username: 'owner', password: PASSWORD })

        expect(account.admin).toBe(false)
        expect(session).toMatchObject({ ok: true, admin: false })
        expect(await ask(socket, 'createInvitation')).toEqual({ ok: false, message: 'Only for administrators' })
    })

    it('keep the flag when the name is later taken off the list', async () => {
        app = await startApp(PRIVATE)
        await ownerSocket()
        const kept = await Identity.findOne({ username: 'owner' }).lean()
        await app.stop()
        await Identity.create(kept)

        app = await startApp({ ...PRIVATE, adminUsernames: [] })
        const session = await login(await app.client(), { username: 'owner', password: PASSWORD })

        expect(session).toMatchObject({ ok: true, admin: true })
    })
})

describe('guest names', () => {
    const idleGuest = (username, idleMs) => Identity.create({
        userId: randomUUID(), username, kind: 'guest', secretHash: 'x', lastSeenAt: new Date(Date.now() - idleMs),
    })

    it('lapse after 30 days idle where nothing else is configured, and never while connected', async () => {
        app = await startApp()
        await idleGuest('almost', 29 * DAY)
        await idleGuest('lapsed', 31 * DAY)
        const connected = await app.client()
        await login(connected, { username: 'connected' })
        await Identity.updateOne({ username: 'connected' }, { lastSeenAt: new Date(Date.now() - 90 * DAY) })
        await register(await app.client(), 'account')
        await Identity.updateOne({ username: 'account' }, { lastSeenAt: new Date(Date.now() - 400 * DAY) })

        expect(await app.runMaintenance()).toEqual({ removedGuests: 1 })

        expect((await Identity.find().lean()).map(identity => identity.username).sort())
            .toEqual(['account', 'almost', 'connected'])
        // Being connected counts as being seen.
        const { lastSeenAt } = await Identity.findOne({ username: 'connected' }).lean()
        expect(Date.now() - lastSeenAt.getTime()).toBeLessThan(5000)
    })

    it.each([
        ['with messages expiring after 24 h, lapse after 24 h', 24, 23 * HOUR, 25 * HOUR],
        ['with expiry explicitly off (0), lapse after 30 days', 0, 29 * DAY, 31 * DAY],
    ])('%s', async (_label, messageTtlHours, kept, lapsed) => {
        app = await startApp({ messageTtlHours })
        await idleGuest('kept', kept)
        await idleGuest('lapsed', lapsed)

        expect(await app.runMaintenance()).toEqual({ removedGuests: 1 })

        expect((await Identity.find().lean()).map(identity => identity.username)).toEqual(['kept'])
    })

    it('go to a new identity once lapsed: the next person to take the name is somebody else', async () => {
        app = await startApp()
        const first = await app.client()
        const { reservation } = await login(first, { username: 'alice' })
        const { userId } = await Identity.findOne({ username: 'alice' }).lean()
        first.close()
        await expect.poll(() => onlineUsers(app)).toEqual([])

        expect(await app.runMaintenance({ now: Date.now() + 31 * DAY })).toEqual({ removedGuests: 1 })

        const next = await app.client()
        const session = await login(next, { username: 'alice' })
        expect(session.ok).toBe(true)
        expect(session.reservation).not.toBe(reservation)
        expect((await Identity.findOne({ username: 'alice' }).lean()).userId).not.toBe(userId)
        // The previous owner's secret opens nothing now.
        expect(await login(await app.client(), { username: 'alice', reservation }))
            .toEqual({ ok: false, message: 'Username already in use' })
    })

    it('are refreshed by logging in, so a returning guest is not swept away', async () => {
        app = await startApp()
        const first = await app.client()
        const { reservation } = await login(first, { username: 'alice' })
        first.close()
        await expect.poll(() => onlineUsers(app)).toEqual([])
        await Identity.updateOne({ username: 'alice' }, { lastSeenAt: new Date(Date.now() - 29 * DAY) })

        const back = await app.client()
        await login(back, { username: 'alice', reservation })
        back.close()
        await expect.poll(() => onlineUsers(app)).toEqual([])

        expect(await app.runMaintenance({ now: Date.now() + 2 * DAY })).toEqual({ removedGuests: 0 })
    })

    it('are limited in number per client address', async () => {
        app = await startApp({ trustedProxyHops: 1, limits: { newGuestsPerAddress: { limit: 2, windowMs: 60_000 } } })
        const from = address => app.client({ address })

        const answers = []
        for (const name of ['a', 'b', 'c']) answers.push(await login(await from('203.0.113.9'), { username: name }))

        expect(answers.map(answer => answer.ok)).toEqual([true, true, false])
        expect(answers[2].message).toBe('Too many new names from this network, try again later')
        // Coming back to a name already held is not a new name; nor is another address held up.
        const again = await from('203.0.113.9')
        expect((await login(again, { username: 'a', reservation: answers[0].reservation })).ok).toBe(true)
        expect((await login(await from('198.51.100.20'), { username: 'c' })).ok).toBe(true)
    })

    it('are taken from a connected guest only by whoever holds the secret, who then replaces them', async () => {
        app = await startApp()
        const first = await app.client()
        const { reservation } = await login(first, { username: 'alice' })
        const kicked = nextEvent(first, 'disconnect')

        const second = await app.client()
        expect((await login(second, { username: 'alice', reservation })).ok).toBe(true)

        expect(await kicked).toBe('io server disconnect')
    })
})
