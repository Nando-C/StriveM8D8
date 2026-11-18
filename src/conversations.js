import { Conversation } from './models/conversation.js'
import { Message } from './models/message.js'
import { afterPosition, comparePositions, laterPosition } from './positions.js'

// Everything about conversations that is not tied to a socket: their ids, who may see
// what in them, and the one view of a conversation that is ever sent to a client.

export const MAX_LISTED_CONVERSATIONS = 50
export const MAX_UNREAD_SHOWN = 99
export const PREVIEW_LENGTH = 80

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

const seesLastMessage = (conversation, member) => {
    const last = conversation.lastMessage
    if (!last?.id) return false
    return comparePositions({ ts: last.timestamp, id: last.id }, plainPosition(member.joinedAfter)) > 0
}

/** How many messages from other people the member has not read, up to 100. */
export const unreadCountFor = async (conversation, member) => {
    const from = laterPosition(plainPosition(member.readUpTo), plainPosition(member.joinedAfter))
    // Most conversations, most of the time, have nothing new in them — and the conversation
    // itself already says so: its last message is not after where this member stopped.
    // Only the ones that might have something unread cost a query.
    const last = conversation.lastMessage
    if (!last?.id || comparePositions({ ts: last.timestamp, id: last.id }, from) <= 0) return 0
    const count = await Message.countDocuments(
        { conversationKey: conversation._id, from: { $ne: member.userId }, ...afterPosition(from) },
        { limit: MAX_UNREAD_SHOWN + 1 },
    )
    return Math.min(count, MAX_UNREAD_SHOWN)
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
            deliveredUpTo: plainPosition(member.deliveredUpTo),
            readUpTo: plainPosition(member.readUpTo),
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

/**
 * Moves one member's `field` (readUpTo or deliveredUpTo) forward to `position`. Never
 * backwards: the condition is part of the same atomic update. Resolves to whether it moved.
 */
export const advancePosition = async (conversationId, userId, field, position) => {
    const result = await Conversation.updateOne(
        {
            _id: conversationId,
            members: {
                $elemMatch: {
                    userId,
                    $or: [
                        { [field]: null },
                        { [`${field}.ts`]: { $lt: position.ts } },
                        { [`${field}.ts`]: position.ts, [`${field}.id`]: { $lt: position.id } },
                    ],
                },
            },
        },
        { $set: { [`members.$.${field}`]: position } },
    )
    return result.modifiedCount === 1
}

/** The text shown under a conversation's name in the list. */
export const previewOf = text => {
    const flat = String(text ?? '').trim().replace(/\s+/g, ' ')
    return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat
}
