import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BOT } from '../src/bot.js'
import { Conversation } from '../src/models/conversation.js'
import { Identity } from '../src/models/identity.js'
import { Message } from '../src/models/message.js'
import { MAX_GROUPS_CREATED, MAX_GROUP_MEMBERSHIPS, MAX_GROUP_MEMBERS } from '../src/sockets/groups.js'
import {
    PASSWORD, acknowledging, ask, connectTestDatabase, disconnectTestDatabase, getHistory, join, login, markRead,
    messageTo, nextEvent, positionOf, record, register, send, settle, startApp,
} from './helpers.js'

let app

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
beforeEach(async () => {
    app = await startApp()
})
afterEach(() => app.stop())

const UNKNOWN = 'Unknown conversation'
const ADMIN_ONLY = 'Only the group admin can do that'
const DAY = 24 * 60 * 60_000

// Guests whose clients acknowledge what they are sent, as the real client does.
const people = async (...names) => {
    const joined = []
    for (const name of names) {
        const person = await join(app, name)
        acknowledging(person.socket)
        joined.push(person)
    }
    return joined
}

const who = person => ({ userId: person.userId, username: person.username })
const ids = (...members) => members.map(member => member.userId)

/** Creates a group and resolves with its id, once every connected member has been told of it. */
const group = async (creator, others, name = 'Trip') => {
    const told = [creator, ...others].filter(member => member.socket?.connected)
        .map(member => nextEvent(member.socket, 'message'))
    const ack = await ask(creator.socket, 'createGroup', { name, userIds: ids(...others) })
    expect(ack).toEqual({ ok: true, conversationId: expect.stringMatching(/^group:[0-9a-f-]{36}$/) })
    await Promise.all(told)
    return ack.conversationId
}

const stored = id => Conversation.findById(id).lean()
const memberIn = (view, user) => view.members.find(member => member.userId === user.userId)
const systemLines = async id =>
    (await Message.find({ conversationKey: id, kind: 'system' }).sort({ createdAt: 1, _id: 1 }).lean()).map(message => message.data)

/** A stored group nobody made through the server: for caps that would take hundreds of requests to reach. */
const storedGroup = (members, extra = {}) => ({
    _id: `group:${randomUUID()}`, kind: 'group', name: 'filler', members, ...extra,
})
const strangers = count => Array.from({ length: count }, (_, index) => ({ userId: randomUUID(), username: `stranger${index}` }))

describe('creating a group', () => {
    it('tells every member, each with their own view, and then records how it began', async () => {
        const [alice, bob, carol, dave] = await people('alice', 'bob', 'carol', 'dave')
        const outsider = [record(dave.socket, 'conversationUpdated'), record(dave.socket, 'message')]
        const order = []
        for (const event of ['conversationUpdated', 'message']) bob.socket.on(event, () => order.push(event))
        const views = [alice, bob, carol].map(member => nextEvent(member.socket, 'conversationUpdated'))
        const lines = [alice, bob, carol].map(member => nextEvent(member.socket, 'message'))

        const ack = await ask(alice.socket, 'createGroup', { name: '  Trip   to Rome ', userIds: ids(bob, carol) })
        expect(ack.ok).toBe(true)
        const id = ack.conversationId

        const created = { event: 'created', actor: who(alice), name: 'Trip to Rome', targets: [who(bob), who(carol)] }
        for (const told of await Promise.all(views)) {
            expect(told.conversation).toMatchObject({
                id, kind: 'group', name: 'Trip to Rome', admin: alice.userId, unreadCount: 0,
                lastMessage: { from: alice.userId, fromName: 'alice', preview: '', kind: 'system', data: created },
            })
            expect(ids(...told.conversation.members)).toEqual(ids(alice, bob, carol))
            // Its first members see all of it.
            expect(told.conversation.members.every(member => !('joinedAfter' in member))).toBe(true)
        }
        for (const line of await Promise.all(lines)) {
            expect(line).toMatchObject({ conversationId: id, kind: 'system', text: null, from: alice.userId, data: created })
        }
        // Nobody is sent a message of a group they have not been told about yet.
        expect(order.slice(0, 2)).toEqual(['conversationUpdated', 'message'])

        expect(await stored(id)).toMatchObject({ createdBy: alice.userId, admin: alice.userId })
        await settle()
        expect(outsider).toEqual([[], []])
    })

    it('is refused without a proper name, without anyone else, or with someone who does not exist', async () => {
        const [alice, bob] = await people('alice', 'bob')
        const create = payload => ask(alice.socket, 'createGroup', payload)
        const NAME = { ok: false, message: 'A group name must be 1 to 50 characters' }
        const MEMBERS = { ok: false, message: 'Choose at least one other person' }

        expect(await create({ name: '   ', userIds: ids(bob) })).toEqual(NAME)
        expect(await create({ name: 'x'.repeat(51), userIds: ids(bob) })).toEqual(NAME)
        expect(await create({ userIds: ids(bob) })).toEqual(NAME)
        expect(await create({ name: 'Trip' })).toEqual(MEMBERS)
        expect(await create({ name: 'Trip', userIds: [] })).toEqual(MEMBERS)
        expect(await create({ name: 'Trip', userIds: [alice.userId] })).toEqual(MEMBERS)
        expect(await create({ name: 'Trip', userIds: [{ $ne: null }] })).toEqual(MEMBERS)
        expect(await create({ name: 'Trip', userIds: [bob.userId, randomUUID()] })).toEqual({ ok: false, message: 'Unknown user' })
        // The bot is nobody where it is switched off.
        expect(await create({ name: 'Trip', userIds: [BOT.id] })).toEqual({ ok: false, message: 'Unknown user' })
        expect(await Conversation.countDocuments({})).toBe(0)

        const nobody = await app.client()
        expect(await ask(nobody, 'createGroup', { name: 'Trip', userIds: ids(bob) })).toEqual({ ok: false, message: 'Not logged in' })
    })

    it('holds at most twenty people', async () => {
        const [alice] = await people('alice')
        const many = strangers(MAX_GROUP_MEMBERS)
        await Identity.insertMany(many.map(person => ({ ...person, kind: 'guest', secretHash: 'x' })))

        expect(await ask(alice.socket, 'createGroup', { name: 'Crowd', userIds: ids(...many) }))
            .toEqual({ ok: false, message: 'A group can have at most 20 members' })
        expect((await ask(alice.socket, 'createGroup', { name: 'Crowd', userIds: ids(...many.slice(1)) })).ok).toBe(true)
    })

    it('counts against whoever creates it, not against the people put in it', async () => {
        const [alice, bob] = await people('alice', 'bob')
        await Conversation.insertMany(Array.from({ length: MAX_GROUPS_CREATED }, () =>
            storedGroup([who(alice), who(bob)], { createdBy: alice.userId, admin: alice.userId })))

        expect(await ask(alice.socket, 'createGroup', { name: 'One more', userIds: ids(bob) }))
            .toEqual({ ok: false, message: 'You have created 20 groups — leave or empty one first' })
        // Bob is in all twenty and has made none: his allowance is untouched.
        expect((await ask(bob.socket, 'createGroup', { name: 'Mine', userIds: ids(alice) })).ok).toBe(true)
    })

    it('cannot put anyone in more groups than one person may be in', async () => {
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        const mine = await group(alice, [carol])
        await Conversation.insertMany(Array.from({ length: MAX_GROUP_MEMBERSHIPS }, () => storedGroup([who(bob)])))

        const THEIRS = { ok: false, message: 'One of these people is in too many groups' }
        expect(await ask(alice.socket, 'createGroup', { name: 'Trip', userIds: ids(bob, carol) })).toEqual(THEIRS)
        expect(await ask(alice.socket, 'addMembers', { conversationId: mine, userIds: ids(bob) })).toEqual(THEIRS)
        expect(await ask(bob.socket, 'createGroup', { name: 'Trip', userIds: ids(alice) }))
            .toEqual({ ok: false, message: 'You are in too many groups' })
        expect(memberIn(await stored(mine), bob)).toBeUndefined()
    })
})

describe('messages in a group', () => {
    it('reach every other member exactly once, and wait as unread for a member who is away', async () => {
        const [alice, bob, carol, dave] = await people('alice', 'bob', 'carol', 'dave')
        const id = await group(alice, [bob, carol])
        carol.socket.close()
        await settle()
        const seen = { alice: record(alice.socket, 'message'), bob: record(bob.socket, 'message'), dave: record(dave.socket, 'message') }

        const arrived = nextEvent(bob.socket, 'message')
        const ack = await send(alice.socket, messageTo(id, 'hello all'))
        expect(ack.ok).toBe(true)
        await arrived
        await settle()

        expect(seen.bob.map(message => message.text)).toEqual(['hello all'])
        expect(seen.bob[0]).toMatchObject({ id: ack.id, conversationId: id, from: alice.userId, fromName: 'alice', kind: 'text' })
        expect(seen.alice).toEqual([])
        expect(seen.dave).toEqual([])

        const again = await app.client()
        const session = await login(again, { username: 'carol', reservation: carol.reservation })
        expect(session.conversations).toHaveLength(1)
        // (How the group began is not a message to read: only alice's is counted.)
        expect(session.conversations[0]).toMatchObject({ id, unreadCount: 1, lastMessage: { id: ack.id, preview: 'hello all' } })
        expect(session.conversations[0].lastMessage).not.toHaveProperty('kind')
    })

    it('cannot be sent or read by someone who is not in it', async () => {
        const [alice, bob, mallory] = await people('alice', 'bob', 'mallory')
        const id = await group(alice, [bob])
        await send(alice.socket, messageTo(id, 'private'))

        expect(await send(mallory.socket, messageTo(id, 'let me in'))).toEqual({ ok: false, message: UNKNOWN })
        expect(await getHistory(mallory.socket, { conversationId: id })).toEqual({ ok: false, conversationId: id, message: UNKNOWN })
        expect(await markRead(mallory.socket, id, { ts: Date.now(), id: 'f'.repeat(24) })).toEqual({ ok: false, message: UNKNOWN })
        for (const [event, payload] of [
            ['addMembers', { userIds: [mallory.userId] }], ['removeMember', { userId: bob.userId }],
            ['leaveGroup', {}], ['renameGroup', { name: 'Mine now' }],
        ]) {
            expect(await ask(mallory.socket, event, { conversationId: id, ...payload })).toEqual({ ok: false, message: UNKNOWN })
        }
        // And a made-up id is answered the same way as a real one.
        expect(await ask(mallory.socket, 'leaveGroup', { conversationId: `group:${randomUUID()}` })).toEqual({ ok: false, message: UNKNOWN })
        expect(await ask(mallory.socket, 'leaveGroup', { conversationId: { $ne: null } })).toEqual({ ok: false, message: UNKNOWN })
        expect((await stored(id)).name).toBe('Trip')
    })
})

describe('adding people', () => {
    it('can be done by any member; the group is told, and the newcomer starts from there', async () => {
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        const id = await group(alice, [bob])
        const before = await send(alice.socket, messageTo(id, 'before carol'))

        const line = nextEvent(alice.socket, 'message')
        const forAlice = nextEvent(alice.socket, 'conversationUpdated')
        const forCarol = nextEvent(carol.socket, 'conversationUpdated')
        const sentToCarol = record(carol.socket, 'message')
        // (Bob is not the admin.)
        expect(await ask(bob.socket, 'addMembers', { conversationId: id, userIds: ids(carol, alice) })).toEqual({ ok: true })

        const added = await line
        expect(added).toMatchObject({ kind: 'system', from: bob.userId, data: { event: 'added', actor: who(bob), targets: [who(carol)] } })
        const joinedAfter = positionOf(added)
        expect(memberIn((await forAlice).conversation, carol)).toEqual({ ...who(carol), joinedAfter, deliveredUpTo: joinedAfter, readUpTo: joinedAfter })

        // Carol is shown the group, with nothing of what was said before her.
        const view = (await forCarol).conversation
        expect(view).toMatchObject({ id, kind: 'group', admin: alice.userId, unreadCount: 0, lastMessage: null })
        expect(ids(...view.members)).toEqual(ids(alice, bob, carol))
        expect((await getHistory(carol.socket, { conversationId: id })).messages).toEqual([])
        await settle()
        expect(sentToCarol).toEqual([])

        // At her next login too: no preview, nothing unread.
        const second = nextEvent(carol.socket, 'message')
        const after = await send(alice.socket, messageTo(id, 'welcome carol'))
        await second
        carol.socket.close()
        const again = await app.client()
        const session = await login(again, { username: 'carol', reservation: carol.reservation })
        expect(session.conversations[0]).toMatchObject({ unreadCount: 1, lastMessage: { id: after.id } })
        const history = await getHistory(again, { conversationId: id })
        expect(history.messages.map(message => message.id)).toEqual([after.id])
        expect(history.hasMore).toBe(false)
        expect(history.messages.map(message => message.id)).not.toContain(before.id)
    })

    it('shows a newcomer nothing unread and no preview while only earlier messages exist', async () => {
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        const id = await group(alice, [bob])
        await send(alice.socket, messageTo(id, 'one'))
        await send(bob.socket, messageTo(id, 'two'))
        carol.socket.close()
        await settle()

        expect((await ask(alice.socket, 'addMembers', { conversationId: id, userIds: ids(carol) })).ok).toBe(true)
        const again = await app.client()
        const session = await login(again, { username: 'carol', reservation: carol.reservation })
        expect(session.conversations[0]).toMatchObject({ id, unreadCount: 0, lastMessage: null })
    })

    it('is refused for someone already in, someone unknown, and a group that is full', async () => {
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        const id = await group(alice, [bob])
        const add = (conversationId, userIds) => ask(alice.socket, 'addMembers', { conversationId, userIds })

        expect(await add(id, ids(bob))).toEqual({ ok: false, message: 'Already in this group' })
        expect(await add(id, [randomUUID()])).toEqual({ ok: false, message: 'Unknown user' })
        expect(await add(id, 'bob')).toEqual({ ok: false, message: 'Choose at least one other person' })

        const full = storedGroup([who(alice), ...strangers(MAX_GROUP_MEMBERS - 1)], { admin: alice.userId })
        await Conversation.create(full)
        expect(await add(full._id, ids(carol))).toEqual({ ok: false, message: 'A group can have at most 20 members' })
        expect((await stored(full._id)).members).toHaveLength(MAX_GROUP_MEMBERS)
    })

    it('never goes past the cap when two members add someone at the same moment', async () => {
        const [alice, bob, carol, dave] = await people('alice', 'bob', 'carol', 'dave')
        const nearlyFull = storedGroup([who(alice), who(bob), ...strangers(MAX_GROUP_MEMBERS - 3)], { admin: alice.userId })
        await Conversation.create(nearlyFull)
        const id = nearlyFull._id

        const answers = await Promise.all([
            ask(alice.socket, 'addMembers', { conversationId: id, userIds: ids(carol) }),
            ask(bob.socket, 'addMembers', { conversationId: id, userIds: ids(dave) }),
        ])
        expect(answers.filter(answer => answer.ok)).toHaveLength(1)
        expect(answers.find(answer => !answer.ok).message).toMatch(/at most 20 members|changed in the meantime/)
        expect((await stored(id)).members).toHaveLength(MAX_GROUP_MEMBERS)
        // Only what really happened is written into the group.
        expect(await systemLines(id)).toHaveLength(1)
    })

    it('is limited more tightly than the other group requests', async () => {
        const [alice, bob] = await people('alice', 'bob')
        const id = await group(alice, [bob])
        const answers = []
        for (let attempt = 0; attempt < 6; attempt += 1) {
            answers.push(await ask(alice.socket, 'addMembers', { conversationId: id, userIds: ids(bob) }))
        }
        expect(answers.slice(0, 5).every(answer => answer.message === 'Already in this group')).toBe(true)
        expect(answers[5]).toEqual({ ok: false, message: 'Too many requests, slow down' })
        // The others have their own allowance.
        expect(await ask(alice.socket, 'renameGroup', { conversationId: id, name: 'Still fine' })).toEqual({ ok: true })
    })
})

describe('removing someone', () => {
    it('is for the admin only, and never for a non-member or for oneself', async () => {
        const [alice, bob, carol, dave] = await people('alice', 'bob', 'carol', 'dave')
        const id = await group(alice, [bob, carol])

        expect(await ask(bob.socket, 'removeMember', { conversationId: id, userId: carol.userId })).toEqual({ ok: false, message: ADMIN_ONLY })
        expect(await ask(alice.socket, 'removeMember', { conversationId: id, userId: dave.userId })).toEqual({ ok: false, message: 'Not in this group' })
        expect(await ask(alice.socket, 'removeMember', { conversationId: id })).toEqual({ ok: false, message: 'Not in this group' })
        expect(await ask(alice.socket, 'removeMember', { conversationId: id, userId: alice.userId }))
            .toEqual({ ok: false, message: 'To go yourself, leave the group' })
        expect(ids(...(await stored(id)).members)).toEqual(ids(alice, bob, carol))
    })

    it('takes away their access at once: they are told, and then hear and can read nothing more', async () => {
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        const id = await group(alice, [bob, carol])
        const first = nextEvent(carol.socket, 'message')
        await send(alice.socket, messageTo(id, 'while carol was here'))
        await first
        // (Everything that message set off — who received it — has been said by now.)
        await settle()

        const gone = nextEvent(carol.socket, 'conversationRemoved')
        const line = nextEvent(bob.socket, 'message')
        const forBob = nextEvent(bob.socket, 'conversationUpdated')
        const heard = ['message', 'conversationUpdated', 'receipt'].map(event => record(carol.socket, event))
        expect(await ask(alice.socket, 'removeMember', { conversationId: id, userId: carol.userId })).toEqual({ ok: true })

        expect(await gone).toEqual({ id })
        expect(await line).toMatchObject({ kind: 'system', data: { event: 'removed', actor: who(alice), target: who(carol) } })
        expect(ids(...(await forBob).conversation.members)).toEqual(ids(alice, bob))
        // Her entry, and with it how far she had read, is gone.
        expect(memberIn(await stored(id), carol)).toBeUndefined()

        const next = nextEvent(bob.socket, 'message')
        const ack = await send(alice.socket, messageTo(id, 'after carol'))
        await next
        await markRead(bob.socket, id, positionOf(ack))
        await settle()
        expect(heard).toEqual([[], [], []])

        expect(await getHistory(carol.socket, { conversationId: id })).toEqual({ ok: false, conversationId: id, message: UNKNOWN })
        expect(await send(carol.socket, messageTo(id, 'still here?'))).toEqual({ ok: false, message: UNKNOWN })
        carol.socket.close()
        const again = await app.client()
        expect((await login(again, { username: 'carol', reservation: carol.reservation })).conversations).toEqual([])
    })

    it('and adding them again starts them afresh, from the new line', async () => {
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        const id = await group(alice, [bob, carol])
        await ask(alice.socket, 'removeMember', { conversationId: id, userId: carol.userId })
        const missed = await send(alice.socket, messageTo(id, 'carol is out'))

        const line = nextEvent(alice.socket, 'message')
        await ask(alice.socket, 'addMembers', { conversationId: id, userIds: ids(carol) })
        const joinedAfter = positionOf(await line)
        expect(joinedAfter.ts).toBeGreaterThanOrEqual(missed.timestamp)
        const entry = memberIn(await stored(id), carol)
        expect({ ts: entry.joinedAfter.ts, id: entry.joinedAfter.id }).toEqual(joinedAfter)
        expect((await getHistory(carol.socket, { conversationId: id })).messages).toEqual([])
    })
})

describe('leaving', () => {
    it('is one action for anyone, and is recorded for those who stay', async () => {
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        const id = await group(alice, [bob, carol])

        const gone = nextEvent(bob.socket, 'conversationRemoved')
        const line = nextEvent(carol.socket, 'message')
        expect(await ask(bob.socket, 'leaveGroup', { conversationId: id })).toEqual({ ok: true })
        expect(await gone).toEqual({ id })
        expect(await line).toMatchObject({ kind: 'system', from: bob.userId, fromName: 'bob', data: { event: 'left', actor: who(bob) } })

        expect(await stored(id)).toMatchObject({ admin: alice.userId })
        expect(ids(...(await stored(id)).members)).toEqual(ids(alice, carol))
        expect(await ask(bob.socket, 'leaveGroup', { conversationId: id })).toEqual({ ok: false, message: UNKNOWN })
    })

    it('by the admin hands the group to whoever has been in it longest — never the bot', async () => {
        await app.stop()
        app = await startApp({ demoBot: true })
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        const bot = { userId: BOT.id, username: BOT.username }
        const id = await group(alice, [bot, bob])
        await ask(alice.socket, 'addMembers', { conversationId: id, userIds: ids(carol) })

        const forBob = nextEvent(bob.socket, 'conversationUpdated')
        expect(await ask(alice.socket, 'leaveGroup', { conversationId: id })).toEqual({ ok: true })
        expect((await forBob).conversation).toMatchObject({ admin: bob.userId })
        expect(ids(...(await stored(id)).members)).toEqual([BOT.id, bob.userId, carol.userId])

        // The new admin can do what an admin does; the old one is nobody here now.
        expect(await ask(bob.socket, 'renameGroup', { conversationId: id, name: 'Ours' })).toEqual({ ok: true })
        expect(await ask(alice.socket, 'renameGroup', { conversationId: id, name: 'Mine' })).toEqual({ ok: false, message: UNKNOWN })
    })

    it('by the last person deletes the group and what was said in it, bot or no bot', async () => {
        await app.stop()
        app = await startApp({ demoBot: true })
        const [alice, bob] = await people('alice', 'bob')
        const id = await group(alice, [{ userId: BOT.id }, bob])
        await send(alice.socket, messageTo(id, 'hello'))

        await ask(alice.socket, 'leaveGroup', { conversationId: id })
        expect(await stored(id)).toMatchObject({ admin: bob.userId })
        const gone = nextEvent(bob.socket, 'conversationRemoved')
        expect(await ask(bob.socket, 'leaveGroup', { conversationId: id })).toEqual({ ok: true })
        expect(await gone).toEqual({ id })

        expect(await stored(id)).toBeNull()
        expect(await Message.countDocuments({ conversationKey: id })).toBe(0)
        // Nothing of it counts against its creator any more.
        expect(await Conversation.countDocuments({ createdBy: alice.userId })).toBe(0)
    })
})

describe('renaming', () => {
    it('is for the admin only, and is recorded', async () => {
        const [alice, bob] = await people('alice', 'bob')
        const id = await group(alice, [bob])

        expect(await ask(bob.socket, 'renameGroup', { conversationId: id, name: 'Bob’s' })).toEqual({ ok: false, message: ADMIN_ONLY })
        expect(await ask(alice.socket, 'renameGroup', { conversationId: id, name: '' }))
            .toEqual({ ok: false, message: 'A group name must be 1 to 50 characters' })

        const line = nextEvent(bob.socket, 'message')
        const forBob = nextEvent(bob.socket, 'conversationUpdated')
        expect(await ask(alice.socket, 'renameGroup', { conversationId: id, name: ' Rome 2027 ' })).toEqual({ ok: true })
        expect((await forBob).conversation).toMatchObject({ id, name: 'Rome 2027' })
        expect(await line).toMatchObject({ kind: 'system', data: { event: 'renamed', actor: who(alice), name: 'Rome 2027' } })

        // The name it already has changes nothing, and says nothing.
        expect(await ask(alice.socket, 'renameGroup', { conversationId: id, name: 'Rome 2027' })).toEqual({ ok: true })
        expect((await systemLines(id)).map(data => data.event)).toEqual(['created', 'renamed'])
    })

    it('does not give away how far an invisible member has read', async () => {
        const [alice, bob] = await people('alice', 'bob')
        const id = await group(alice, [bob])
        await ask(bob.socket, 'setStatus', { status: 'invisible' })

        const arrived = nextEvent(bob.socket, 'message')
        const ack = await send(alice.socket, messageTo(id, 'are you there?'))
        await arrived
        expect(await markRead(bob.socket, id, positionOf(ack))).toEqual({ ok: true })

        const forAlice = nextEvent(alice.socket, 'conversationUpdated')
        const forBob = nextEvent(bob.socket, 'conversationUpdated')
        await ask(alice.socket, 'renameGroup', { conversationId: id, name: 'Renamed' })

        // Alice is told what bob had let be known before he hid — nothing of this message.
        const shown = memberIn((await forAlice).conversation, bob)
        expect(shown.readUpTo).toBeNull()
        expect(shown.deliveredUpTo?.id ?? null).not.toBe(ack.id)
        // Bob himself is told the truth.
        expect(memberIn((await forBob).conversation, bob).readUpTo).toEqual(positionOf(ack))
    })

    it('is not something unread for a member who was away', async () => {
        const [alice, bob] = await people('alice', 'bob')
        const id = await group(alice, [bob])
        bob.socket.close()
        await settle()
        await ask(alice.socket, 'renameGroup', { conversationId: id, name: 'Renamed' })

        const again = await app.client()
        const session = await login(again, { username: 'bob', reservation: bob.reservation })
        expect(session.conversations[0]).toMatchObject({
            name: 'Renamed', unreadCount: 0, lastMessage: { kind: 'system', data: { event: 'renamed' } },
        })
    })
})

describe('someone who no longer exists', () => {
    // A guest who has not been seen for longer than guests are kept.
    const lapse = async person => {
        person.socket.close()
        await settle()
        await Identity.updateOne({ userId: person.userId }, { lastSeenAt: new Date(Date.now() - 400 * DAY) })
    }

    it('is taken out of their groups by the sweep, and stops counting: in the list, the cap and the succession', async () => {
        const [ghost, bob, carol] = await people('ghost', 'bob', 'carol')
        const id = await group(ghost, [bob])
        // A second group, full, with the ghost in it.
        const full = storedGroup([who(bob), who(ghost), ...strangers(MAX_GROUP_MEMBERS - 2)], { admin: bob.userId })
        await Conversation.create(full)
        const FULL = { ok: false, message: 'A group can have at most 20 members' }
        expect(await ask(bob.socket, 'addMembers', { conversationId: full._id, userIds: ids(carol) })).toEqual(FULL)

        await lapse(ghost)
        const line = nextEvent(bob.socket, 'message')
        const updates = record(bob.socket, 'conversationUpdated')
        expect(await app.runMaintenance()).toEqual({ removedGuests: 1 })

        expect(await line).toMatchObject({ kind: 'system', data: { event: 'left', actor: who(ghost) } })
        // Bob, the only one left, is the admin now; the ghost is in nobody's member list
        // (which is what ticks are worked out from).
        expect(await stored(id)).toMatchObject({ admin: bob.userId })
        expect(ids(...(await stored(id)).members)).toEqual(ids(bob))
        await settle()
        expect(updates.find(update => update.conversation.id === id).conversation).toMatchObject({ admin: bob.userId })
        expect(updates.every(update => !memberIn(update.conversation, ghost))).toBe(true)
        // And there is room in the full one again.
        expect(await ask(bob.socket, 'addMembers', { conversationId: full._id, userIds: ids(carol) })).toEqual({ ok: true })
    })

    it('leaves their groups when it is an account that was deleted', async () => {
        const [bob] = await people('bob')
        const socket = acknowledging(await app.client())
        const registered = await register(socket, 'alice')
        const alice = await login(socket, { session: registered.session })
        const id = await group({ ...alice, socket }, [bob])

        const forBob = nextEvent(bob.socket, 'conversationUpdated')
        expect(await ask(socket, 'deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
        expect((await forBob).conversation).toMatchObject({ id, admin: bob.userId })
        expect(ids(...(await stored(id)).members)).toEqual(ids(bob))
    })
})

describe('the bot in a group', () => {
    it('can be added, and answers only what is addressed to it', async () => {
        await app.stop()
        app = await startApp({ demoBot: true })
        const [alice, bob] = await people('alice', 'bob')
        const id = await group(alice, [bob, { userId: BOT.id }])
        const heard = record(bob.socket, 'message')

        const plain = nextEvent(bob.socket, 'message')
        await send(alice.socket, messageTo(id, 'nobody asked the bot, or demo-bot@example.com'))
        await plain
        // Well past the time the bot takes to answer.
        await settle(900)
        expect(heard.map(message => message.from)).toEqual([alice.userId])

        await send(alice.socket, messageTo(id, 'tell me @Demo-Bot something'))
        await expect.poll(() => heard.length, { timeout: 3000 }).toBe(3)
        expect(heard[2]).toMatchObject({ conversationId: id, from: BOT.id, kind: 'text' })
        // It answers what was said, not its own name.
        expect(heard[2].text).not.toContain('@')
        expect(heard[2].text).toContain('“tell me something”')
    })
})

describe('someone who joined later', () => {
    it('is told nothing of where the others stood before that — not in the group as shown, not in receipts', async () => {
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        const id = await group(alice, [bob])
        const reached = nextEvent(alice.socket, 'receipt')
        const before = await send(alice.socket, messageTo(id, 'before carol'))
        await reached

        const forCarol = nextEvent(carol.socket, 'conversationUpdated')
        expect((await ask(alice.socket, 'addMembers', { conversationId: id, userIds: ids(carol) })).ok).toBe(true)
        const view = (await forCarol).conversation
        const joinedAfter = memberIn(view, carol).joinedAfter
        // Positions name messages: an earlier one would say that it exists, and when it was sent.
        for (const earlier of [alice, bob]) {
            const shown = memberIn(view, earlier)
            for (const position of [shown.deliveredUpTo, shown.readUpTo]) {
                expect(position === null || position.id === joinedAfter.id).toBe(true)
            }
        }
        expect(JSON.stringify(view)).not.toContain(before.id)

        // Bob reads the earlier message: news for alice, nothing carol may hear of.
        const receipts = record(carol.socket, 'receipt')
        const forAlice = record(alice.socket, 'receipt')
        await markRead(bob.socket, id, positionOf(before))
        await settle()
        expect(forAlice).toContainEqual(expect.objectContaining({ userId: bob.userId, readUpTo: positionOf(before) }))
        expect(JSON.stringify(receipts)).not.toContain(before.id)

        // What happens from then on, she is told like anyone else.
        const after = await send(alice.socket, messageTo(id, 'welcome'))
        await markRead(bob.socket, id, positionOf(after))
        await settle()
        expect(receipts.at(-1)).toMatchObject({ userId: bob.userId, readUpTo: positionOf(after) })
    })
})

// Each of these is two requests whose database operations interleave. They are run a few
// times over, since any one run may happen to fall the harmless way round.
describe('at the same moment', () => {
    const ROUNDS = 5

    /** Everything a socket is sent about one group, in order. */
    const heardOf = (socket, id) => {
        const heard = []
        socket.onAny((event, payload) => {
            const about = payload?.conversationId ?? payload?.conversation?.id ?? payload?.id
            if (about === id) heard.push(event)
        })
        return heard
    }
    const nothingAfterRemoval = heard => {
        expect(heard).toContain('conversationRemoved')
        expect(heard.slice(heard.indexOf('conversationRemoved') + 1)).toEqual([])
    }

    it('a message sent as someone is removed does not reach them afterwards', async () => {
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        for (let round = 0; round < ROUNDS; round += 1) {
            const id = await group(alice, [bob, carol], `Round ${round}`)
            await settle(50)
            const heard = heardOf(carol.socket, id)
            const [sent, removed] = await Promise.all([
                send(bob.socket, messageTo(id, 'not for carol any more')),
                ask(alice.socket, 'removeMember', { conversationId: id, userId: carol.userId }),
            ])
            expect([sent.ok, removed.ok]).toEqual([true, true])
            await settle()
            nothingAfterRemoval(heard)
            carol.socket.offAny()
        }
    })

    it('the admin and the next in line leave: whoever stays is the admin', async () => {
        const [alice, bob, carol] = await people('alice', 'bob', 'carol')
        for (let round = 0; round < ROUNDS; round += 1) {
            const id = await group(alice, [bob, carol], `Round ${round}`)
            await Promise.all([
                ask(alice.socket, 'leaveGroup', { conversationId: id }),
                ask(bob.socket, 'leaveGroup', { conversationId: id }),
            ])
            await settle()
            const left = await stored(id)
            expect(ids(...left.members)).toEqual(ids(carol))
            expect(left.admin).toBe(carol.userId)
        }
    })

    it('the last two people leave: nothing of the group remains, and neither is shown it again', async () => {
        const [alice, bob] = await people('alice', 'bob')
        for (let round = 0; round < ROUNDS; round += 1) {
            const id = await group(alice, [bob], `Round ${round}`)
            await settle(50)
            const heard = [heardOf(alice.socket, id), heardOf(bob.socket, id)]
            await Promise.all([
                ask(alice.socket, 'leaveGroup', { conversationId: id }),
                ask(bob.socket, 'leaveGroup', { conversationId: id }),
            ])
            await settle()
            expect(await stored(id)).toBeNull()
            expect(await Message.countDocuments({ conversationKey: id })).toBe(0)
            heard.forEach(nothingAfterRemoval)
            alice.socket.offAny()
            bob.socket.offAny()
        }
    })

    it('one person cannot create more groups than allowed by asking for several at once', async () => {
        const [alice, bob] = await people('alice', 'bob')
        await Conversation.insertMany(Array.from({ length: MAX_GROUPS_CREATED - 1 }, () =>
            storedGroup([who(alice)], { admin: alice.userId, createdBy: alice.userId })))

        const answers = await Promise.all(Array.from({ length: 8 }, (_, index) =>
            ask(alice.socket, 'createGroup', { name: `Group ${index}`, userIds: ids(bob) })))
        await settle()
        expect(answers.filter(answer => answer.ok).length).toBeLessThanOrEqual(1)
        expect(await Conversation.countDocuments({ createdBy: alice.userId })).toBeLessThanOrEqual(MAX_GROUPS_CREATED)
        // A group that was turned down is not left in anyone's list.
        expect(await Conversation.countDocuments({ 'members.userId': bob.userId })).toBe(answers.filter(answer => answer.ok).length)
    })
})
