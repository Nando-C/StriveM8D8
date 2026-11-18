import { Conversation } from './models/conversation.js'
import { Message } from './models/message.js'
import { afterPosition, comparePositions, laterPosition } from './positions.js'

// Everything about conversations that is not tied to a socket: their ids, who may see
// what in them, and the one view of a conversation that is ever sent to a client.

const MAX_LISTED_CONVERSATIONS = 50
const MAX_UNREAD_SHOWN = 99
const PREVIEW_LENGTH = 80

const USER_ID = /^[A-Za-z0-9-]{1,64}$/

/**
 * The id of the direct conversation between two users. The same from either side, so
 * neither has to ask the server for it. The client has the same function
 * (client/src/lib/conversationId.ts); a test on each side checks the same cases.
 */
export const directConversationId = (userIdA, userIdB) => `dm:${[userIdA, userIdB].sort().join('::')}`

/**
 * The two userIds in a well-formed direct id, or null. Used only to decide whether a
 * conversation that does not exist yet may be created — never to decide who may use one
 * that does: that is what its stored member list is for.
 */
export const parseDirectId = id => {
    if (typeof id !== 'string' || !id.startsWith('dm:')) return null
    const parts = id.slice(3).split('::')
    if (parts.length !== 2 || !parts.every(part => USER_ID.test(part))) return null
    const [a, b] = parts
    return a < b ? [a, b] : null
}

export const memberOf = (conversation, userId) =>
    conversation?.members.find(member => member.userId === userId) ?? null

const plainPosition = position => (position?.id ? { ts: position.ts, id: position.id } : null)

/**
 * What a member may see of a conversation, as a condition on its messages. The one rule,
 * used wherever a message can surface: history, unread counts, the last-message preview.
 */
export const visibleTo = member => afterPosition(plainPosition(member.joinedAfter))

/** The position of a conversation's last message (stored, or as sent to a client), or null. */
export const lastPosition = lastMessage => (lastMessage?.id ? { ts: lastMessage.timestamp, id: lastMessage.id } : null)

// (Nothing is after a position; so a conversation with no last message shows none.)
const seesLastMessage = (conversation, member) =>
    comparePositions(lastPosition(conversation.lastMessage), plainPosition(member.joinedAfter)) > 0

/** How many messages from other people the member has not read, up to 100. */
const unreadCountFor = async (conversation, member) => {
    const from = laterPosition(plainPosition(member.readUpTo), plainPosition(member.joinedAfter))
    // Most conversations, most of the time, have nothing new in them — and the conversation
    // itself already says so: its last message is not after where this member stopped.
    // Only the ones that might have something unread cost a query.
    if (comparePositions(lastPosition(conversation.lastMessage), from) <= 0) return 0
    const count = await Message.countDocuments(
        { conversationKey: conversation._id, from: { $ne: member.userId }, ...afterPosition(from) },
        { limit: MAX_UNREAD_SHOWN + 1 },
    )
    return Math.min(count, MAX_UNREAD_SHOWN)
}

/**
 * A member's positions as `viewerId` is told them: their own true ones for themself, and
 * for anyone else only what has been published. An invisible member's reading must not
 * show — not live, and not in what a reload fetches either.
 */
const positionsShownTo = (member, viewerId) => {
    const source = member.userId === viewerId ? member : member.published
    return { deliveredUpTo: plainPosition(source?.deliveredUpTo), readUpTo: plainPosition(source?.readUpTo) }
}

/** What other members are told when one member's positions move: only ever the published ones. */
export const receiptOf = (conversation, userId) => {
    const member = memberOf(conversation, userId)
    return {
        conversationId: conversation._id,
        userId,
        deliveredUpTo: plainPosition(member?.published?.deliveredUpTo),
        readUpTo: plainPosition(member?.published?.readUpTo),
    }
}

/**
 * A conversation as one of its members is shown it. The only place a conversation is
 * turned into something sent to a client, so that a rule about what a member may see
 * cannot be forgotten in one event and kept in another.
 */
export const conversationView = (conversation, userId, unreadCount = 0) => {
    const viewer = memberOf(conversation, userId)
    return {
        id: conversation._id,
        kind: conversation.kind,
        ...(conversation.name ? { name: conversation.name } : {}),
        members: conversation.members.map(member => ({
            userId: member.userId,
            username: member.username,
            ...(member.joinedAfter?.id ? { joinedAfter: plainPosition(member.joinedAfter) } : {}),
            ...positionsShownTo(member, userId),
            ...(member.gone ? { gone: true } : {}),
        })),
        lastMessage: viewer && seesLastMessage(conversation, viewer)
            ? {
                id: conversation.lastMessage.id,
                from: conversation.lastMessage.from,
                fromName: conversation.lastMessage.fromName,
                preview: conversation.lastMessage.preview,
                timestamp: conversation.lastMessage.timestamp,
            }
            : null,
        unreadCount,
    }
}

/** The view of one conversation for one member, with its unread count looked up. */
export const conversationViewFor = async (conversation, userId) => {
    const member = memberOf(conversation, userId)
    return conversationView(conversation, userId, member ? await unreadCountFor(conversation, member) : 0)
}

/** The user's most recently active conversations, as they see them. */
export const conversationsFor = async userId => {
    const conversations = await Conversation
        .find({ 'members.userId': userId })
        .sort({ lastActivityAt: -1 })
        .limit(MAX_LISTED_CONVERSATIONS)
        .lean()
    return Promise.all(conversations.map(conversation => conversationViewFor(conversation, userId)))
}

// Moves one position of one member forward to `position`. Never backwards: the condition
// is part of the same atomic update. `path` is relative to the member entry.
const moveForward = async (conversationId, userId, path, position) => {
    const result = await Conversation.updateOne(
        {
            _id: conversationId,
            members: {
                $elemMatch: {
                    userId,
                    $or: [
                        { [path]: null },
                        { [`${path}.ts`]: { $lt: position.ts } },
                        { [`${path}.ts`]: position.ts, [`${path}.id`]: { $lt: position.id } },
                    ],
                },
            },
        },
        { $set: { [`members.$.${path}`]: position } },
    )
    return result.modifiedCount === 1
}

/**
 * Moves one member's `field` (readUpTo or deliveredUpTo) forward to `position`.
 *
 * `publish`: whether everyone else may be told — false while the member is invisible, in
 * which case only their own, true position moves. Resolves to { moved, published }:
 * whether the true position moved, and whether what others are told did.
 */
export const advancePosition = async (conversationId, userId, field, position, { publish = true } = {}) => {
    // Two fields, each moved by its own atomic update: neither waits for the other.
    const [moved, published] = await Promise.all([
        moveForward(conversationId, userId, field, position),
        publish ? moveForward(conversationId, userId, `published.${field}`, position) : false,
    ])
    return { moved, published }
}

/**
 * Brings what others are told about a member up to the truth, in every conversation
 * they are in: what happens when someone stops being invisible. Resolves to the
 * conversations (as stored afterwards) in which something others can see changed.
 */
export const publishPositions = async userId => {
    const conversations = await Conversation.find({ 'members.userId': userId }).lean()
    const changed = []
    for (const conversation of conversations) {
        const member = memberOf(conversation, userId)
        let moved = false
        for (const field of ['deliveredUpTo', 'readUpTo']) {
            const truth = plainPosition(member[field])
            if (truth === null || comparePositions(truth, plainPosition(member.published?.[field])) <= 0) continue
            if (await moveForward(conversation._id, userId, `published.${field}`, truth)) moved = true
        }
        if (moved) changed.push(await Conversation.findById(conversation._id).lean())
    }
    return changed.filter(Boolean)
}

/** The text shown under a conversation's name in the list. */
export const previewOf = text => {
    const flat = String(text ?? '').trim().replace(/\s+/g, ' ')
    return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat
}
