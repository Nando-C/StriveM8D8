import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import { BOT } from '../bot.js'
import { isUserId, memberOf } from '../conversations.js'
import { isDatabaseReady } from '../db.js'
import { Conversation } from '../models/conversation.js'
import { Identity } from '../models/identity.js'
import { Message } from '../models/message.js'
import { NOT_LOGGED_IN, Refusal, SLOW_DOWN, isObject, refuse, withAck } from './validation.js'

// Group conversations: making one, and changing who is in it or what it is called.
// Sending, reading and receipts are the same as in any conversation (messages.js) — a
// group is only a conversation with a name, an admin and more than two members.
//
// Every change is recorded in the conversation as a system message carrying data, not
// words (`{ event, actor, … }`): the client words it. Members are then each sent their
// own view of the group; someone who is no longer in it is sent `conversationRemoved`.
//
// `members` is kept in the order people joined, which is what decides who takes over
// when the admin goes.

export const MAX_GROUP_NAME_LENGTH = 50
export const MAX_GROUP_MEMBERS = 20
/** Groups one user may have created that still exist. */
export const MAX_GROUPS_CREATED = 20
/** Groups one user may be in. */
export const MAX_GROUP_MEMBERSHIPS = 200

const MAX_CONVERSATION_ID_LENGTH = 200

// Per socket.
const RATE_LIMITS = {
    group: { limit: 10, windowMs: 10_000 },
    // Each one can put a group in front of up to nineteen people.
    addMembers: { limit: 5, windowMs: 10_000 },
}

const UNKNOWN_CONVERSATION = 'Unknown conversation'
const NOT_SAVED = 'Could not be saved'
const INVALID_NAME = `A group name must be 1 to ${MAX_GROUP_NAME_LENGTH} characters`
const INVALID_MEMBERS = 'Choose at least one other person'
// One answer whoever it is that does not exist.
const UNKNOWN_USER = 'Unknown user'
const GROUP_FULL = `A group can have at most ${MAX_GROUP_MEMBERS} members`
const ADMIN_ONLY = 'Only the group admin can do that'
const CHANGED = 'The group changed in the meantime — try again'
const TOO_MANY_CREATED = `You have created ${MAX_GROUPS_CREATED} groups — leave or empty one first`
const TOO_MANY_OWN = 'You are in too many groups'
const TOO_MANY_THEIRS = 'One of these people is in too many groups'

const nameIn = payload => {
    const name = typeof payload.name === 'string' ? payload.name.trim().replace(/\s+/g, ' ') : ''
    if (name.length < 1 || name.length > MAX_GROUP_NAME_LENGTH) refuse(INVALID_NAME)
    return name
}

/** The distinct userIds a request names, without `exceptUserId`. */
const userIdsIn = (payload, exceptUserId) => {
    const given = payload.userIds
    if (!Array.isArray(given) || given.length > MAX_GROUP_MEMBERS || !given.every(isUserId)) refuse(INVALID_MEMBERS)
    const userIds = [...new Set(given)].filter(userId => userId !== exceptUserId)
    if (userIds.length === 0) refuse(INVALID_MEMBERS)
    return userIds
}

const named = member => ({ userId: member.userId, username: member.username })

export const createGroupHandlers = ({ presence, settings, rateLimiter, messages }) => {
    const allowed = rateLimiter.perSocket(RATE_LIMITS)

    /** Each of these users as `{ userId, username }`, in the order given. Every one must exist (or be the bot). */
    const peopleNamed = async userIds => {
        const identities = await Identity.find({ userId: { $in: userIds } }, { userId: 1, username: 1 }).lean()
        const byId = new Map(identities.map(identity => [identity.userId, identity]))
        if (settings.demoBot) byId.set(BOT.id, { userId: BOT.id, username: BOT.username })
        if (!userIds.every(userId => byId.has(userId))) refuse(UNKNOWN_USER)
        return userIds.map(userId => named(byId.get(userId)))
    }

    // Nobody can be put in more groups than the cap — by themself or by anyone else.
    // (The bot is everybody's to add, and is not counted.)
    const requireRoomFor = async (userIds, message) => {
        const counts = await Promise.all(userIds.filter(userId => userId !== BOT.id).map(userId =>
            Conversation.countDocuments({ kind: 'group', 'members.userId': userId }, { limit: MAX_GROUP_MEMBERSHIPS })))
        if (counts.some(count => count >= MAX_GROUP_MEMBERSHIPS)) refuse(message)
    }

    /** The group a request names, if the asker is in it. One answer for "no such group" and "not yours". */
    const groupOf = async (payload, user) => {
        const id = payload.conversationId
        if (typeof id !== 'string' || id.length > MAX_CONVERSATION_ID_LENGTH) refuse(UNKNOWN_CONVERSATION)
        const conversation = await Conversation.findOne({ _id: id, kind: 'group' }).lean()
        if (!memberOf(conversation, user.userId)) refuse(UNKNOWN_CONVERSATION)
        return conversation
    }

    // Writes what happened into the group and tells its members. By now the change itself
    // is stored: if the line cannot be, the members are still told what the group is now.
    const record = async (conversation, author, data, at = null) => {
        try {
            await messages.post(conversation, author, { kind: 'system', data, at }, { describe: 'before' })
        } catch (error) {
            console.error("failed to record a change to a group:", error.name)
            await messages.tellMembers(conversation).catch(() => {})
        }
    }

    /**
     * Takes `leaver` out of a group: they lose access at once, and their positions go with
     * their entry. If they were the admin, whoever has been in the group longest takes
     * over; if nobody is left (the bot is not somebody), the group and its messages are
     * deleted. `only` is an extra condition checked in the same operation as the removal.
     * Resolves to whether they were taken out.
     */
    const depart = async (conversation, leaver, author, data, only = {}) => {
        const id = conversation._id
        const without = await Conversation.findOneAndUpdate(
            { _id: id, kind: 'group', 'members.userId': leaver.userId, ...only },
            { $pull: { members: { userId: leaver.userId } } },
            { returnDocument: 'after' },
        ).lean()
        if (!without) return false
        presence.tell([leaver.userId], 'conversationRemoved', { id })

        const current = await settle(without)
        if (current) await record(current, author, data)
        return true
    }

    // After someone has gone: deletes the group if no people are left, and otherwise makes
    // sure its admin is one of its members. Resolves to the group as it then is, or null
    // if it is gone. Several people can go at the same moment, each seeing the group as it
    // was after their own departure — so the new admin is appointed only if still a
    // member, in the same operation, and otherwise chosen again from the group as stored.
    const settle = async group => {
        for (let attempt = 0; group && attempt < MAX_GROUP_MEMBERS; attempt++) {
            const people = group.members.filter(member => member.userId !== BOT.id)
            if (people.length === 0) {
                // The group first, then its messages: a line being written into it at this
                // moment is either caught by the second, or finds no group and removes itself.
                await Conversation.deleteOne({ _id: group._id })
                await Message.deleteMany({ conversationKey: group._id })
                return null
            }
            if (people.some(member => member.userId === group.admin)) return group
            group = await Conversation.findOneAndUpdate(
                { _id: group._id, admin: group.admin, 'members.userId': people[0].userId },
                { $set: { admin: people[0].userId } },
                { returnDocument: 'after' },
            ).lean() ?? await Conversation.findById(group._id).lean()
        }
        return group
    }

    // ---------- the events

    const createGroup = async ({ user, payload }) => {
        const name = nameIn(payload)
        const actor = named(user)
        const others = await peopleNamed(userIdsIn(payload, user.userId))
        if (others.length + 1 > MAX_GROUP_MEMBERS) refuse(GROUP_FULL)

        // Counted against whoever makes the group, never against the people put in it:
        // nobody can use up someone else's allowance.
        const made = await Conversation.countDocuments({ kind: 'group', createdBy: user.userId }, { limit: MAX_GROUPS_CREATED })
        if (made >= MAX_GROUPS_CREATED) refuse(TOO_MANY_CREATED)
        await requireRoomFor([user.userId], TOO_MANY_OWN)
        await requireRoomFor(others.map(other => other.userId), TOO_MANY_THEIRS)

        // Its first members were there from the start: they have no `joinedAfter`.
        const created = await Conversation.create({
            _id: `group:${randomUUID()}`, kind: 'group', name,
            createdBy: user.userId, admin: user.userId,
            members: [actor, ...others],
        })
        const conversation = created.toObject()
        // Counted again now that it exists: of several made at the same moment, each was
        // counted before the others existed. (Then all of them may be turned down.)
        if (await Conversation.countDocuments({ kind: 'group', createdBy: user.userId }) > MAX_GROUPS_CREATED) {
            await Conversation.deleteOne({ _id: conversation._id })
            refuse(TOO_MANY_CREATED)
        }
        await record(conversation, actor, { event: 'created', actor, name, targets: others })
        return { conversationId: conversation._id }
    }

    const addMembers = async ({ user, payload }) => {
        const conversation = await groupOf(payload, user)
        const newIds = userIdsIn(payload, user.userId).filter(userId => !memberOf(conversation, userId))
        if (newIds.length === 0) refuse('Already in this group')
        if (conversation.members.length + newIds.length > MAX_GROUP_MEMBERS) refuse(GROUP_FULL)
        const added = await peopleNamed(newIds)
        await requireRoomFor(newIds, TOO_MANY_THEIRS)

        // The position of the line that says they were added is decided first, because it
        // is also where each of them starts: they see, and count as unread, only what
        // comes after it.
        const at = { ts: Date.now(), id: new mongoose.Types.ObjectId().toString() }
        const entry = person => ({
            ...person, joinedAfter: at, deliveredUpTo: at, readUpTo: at, published: { deliveredUpTo: at, readUpTo: at },
        })
        // Still a member, still room, and none of them added by someone else meanwhile:
        // checked by the same operation that adds them.
        const updated = await Conversation.findOneAndUpdate(
            {
                _id: conversation._id, kind: 'group',
                $and: [{ 'members.userId': user.userId }, { 'members.userId': { $nin: newIds } }],
                $expr: { $lte: [{ $size: '$members' }, MAX_GROUP_MEMBERS - newIds.length] },
            },
            { $push: { members: { $each: added.map(entry) } } },
            { returnDocument: 'after' },
        ).lean()
        if (!updated) refuse(CHANGED)
        await record(updated, named(user), { event: 'added', actor: named(user), targets: added }, at)
        return {}
    }

    const removeMember = async ({ user, payload }) => {
        const conversation = await groupOf(payload, user)
        if (conversation.admin !== user.userId) refuse(ADMIN_ONLY)
        if (payload.userId === user.userId) refuse('To go yourself, leave the group')
        const target = isUserId(payload.userId) ? memberOf(conversation, payload.userId) : null
        if (!target) refuse('Not in this group')

        const actor = named(user)
        const removed = await depart(
            conversation, target, actor, { event: 'removed', actor, target: named(target) }, { admin: user.userId },
        )
        if (!removed) refuse(CHANGED)
        return {}
    }

    const leaveGroup = async ({ user, payload }) => {
        const conversation = await groupOf(payload, user)
        const actor = named(user)
        // (Gone already — from another device, a moment ago — is what was asked for.)
        await depart(conversation, actor, actor, { event: 'left', actor })
        return {}
    }

    const renameGroup = async ({ user, payload }) => {
        const conversation = await groupOf(payload, user)
        if (conversation.admin !== user.userId) refuse(ADMIN_ONLY)
        const name = nameIn(payload)
        if (name === conversation.name) return {}

        const updated = await Conversation.findOneAndUpdate(
            { _id: conversation._id, kind: 'group', admin: user.userId }, { $set: { name } }, { returnDocument: 'after' },
        ).lean()
        if (!updated) refuse(CHANGED)
        await record(updated, named(user), { event: 'renamed', actor: named(user), name })
        return {}
    }

    // ---------- wiring

    const registerOn = socket => {
        const on = (event, limit, handler) => {
            socket.on(event, async (rawPayload, rawAck) => {
                const { payload, reply, fail } = withAck(rawPayload, rawAck)

                if (!allowed(socket, limit)) return fail(SLOW_DOWN)
                const user = presence.bySocket.get(socket.id)
                if (!user) return fail(NOT_LOGGED_IN)
                if (!isDatabaseReady()) return fail(NOT_SAVED)
                try {
                    const result = await handler({ user, payload: isObject(payload) ? payload : {} })
                    reply({ ok: true, ...result })
                } catch (error) {
                    if (error instanceof Refusal) return fail(error.message)
                    console.error(`${event} failed:`, error?.name)
                    fail(NOT_SAVED)
                }
            })
        }

        on('createGroup', 'group', createGroup)
        on('addMembers', 'addMembers', addMembers)
        on('removeMember', 'group', removeMember)
        on('leaveGroup', 'group', leaveGroup)
        on('renameGroup', 'group', renameGroup)
    }

    /** An identity is gone (an account deleted, a guest lapsed): it leaves every group it was in. */
    const identityRemoved = async userId => {
        const groups = await Conversation.find({ kind: 'group', 'members.userId': userId }).lean()
        for (const group of groups) {
            const actor = named(memberOf(group, userId))
            await depart(group, actor, actor, { event: 'left', actor })
        }
    }

    return { registerOn, identityRemoved }
}
