import { Conversation } from './models/conversation.js'
import { Message } from './models/message.js'
import { BOT } from './bot.js'
import { afterPosition, comparePositions, laterPosition } from './positions.js'

// Everything about conversations that is not tied to a socket: their ids, who may see
// what in them, and the one view of a conversation that is ever sent to a client.

const MAX_LISTED_CONVERSATIONS = 50
const MAX_UNREAD_SHOWN = 99
const PREVIEW_LENGTH = 80

// Kinds of message that are not something to read: what happened to a group, and what is
// left of a message its author deleted.
export const NOT_TO_READ = ['system', 'deleted']

const USER_ID = /^[A-Za-z0-9-]{1,64}$/

export const isUserId = value => typeof value === 'string' && USER_ID.test(value)

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

/**
 * Whether the message at `position` came after the member joined: the same rule as
 * `visibleTo`, for one message in hand. (Nothing is after a position, so no message — a
 * null position — is seen by nobody.)
 */
export const joinedBefore = (member, position) => comparePositions(position, plainPosition(member.joinedAfter)) > 0

const seesLastMessage = (conversation, member) => joinedBefore(member, lastPosition(conversation.lastMessage))

// How many messages from other people the member has not read, up to 100. What happened
// to the conversation itself (someone was added, it was renamed) is not a message to read.
const unreadCountFor = async (conversation, member) => {
    const from = laterPosition(plainPosition(member.readUpTo), plainPosition(member.joinedAfter))
    // Most conversations, most of the time, have nothing new in them — and the conversation
    // itself already says so: its last message is not after where this member stopped.
    // Only the ones that might have something unread cost a query.
    if (comparePositions(lastPosition(conversation.lastMessage), from) <= 0) return 0
    const count = await Message.countDocuments(
        { conversationKey: conversation._id, from: { $ne: member.userId }, kind: { $nin: NOT_TO_READ }, ...afterPosition(from) },
        { limit: MAX_UNREAD_SHOWN + 1 },
    )
    return Math.min(count, MAX_UNREAD_SHOWN)
}

// A position names a message — its id and when it was sent. Somebody who joined later is
// not told of one from before they joined: to them it is "nothing yet".
const sinceJoining = (viewer, position) => {
    const plain = plainPosition(position)
    return viewer && plain && joinedBefore(viewer, plain) ? plain : null
}

/**
 * A member's positions as `viewer` is told them: their own true ones for themself, and
 * for anyone else only what has been published. An invisible member's reading must not
 * show — not live, and not in what a reload fetches either.
 */
const positionsShownTo = (member, viewer) =>
    member.userId === viewer?.userId
        ? { deliveredUpTo: plainPosition(member.deliveredUpTo), readUpTo: plainPosition(member.readUpTo) }
        : publishedTo(member, viewer)

/** What anyone else may know of where a member stands. */
const publishedTo = (member, viewer) => ({
    deliveredUpTo: sinceJoining(viewer, member?.published?.deliveredUpTo),
    readUpTo: sinceJoining(viewer, member?.published?.readUpTo),
})

/**
 * What another member (`viewer`) is told when one member's positions move: only ever the
 * published ones, and nothing from before the viewer joined — null when that leaves
 * nothing to tell.
 */
export const receiptOf = (conversation, userId, viewer) => {
    const { deliveredUpTo, readUpTo } = publishedTo(memberOf(conversation, userId), viewer)
    if (deliveredUpTo === null && readUpTo === null) return null
    return { conversationId: conversation._id, userId, deliveredUpTo, readUpTo }
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
        // Groups: the one member who may rename it and remove people.
        ...(conversation.kind === 'group' ? { admin: conversation.admin ?? null } : {}),
        members: conversation.members.map(member => ({
            userId: member.userId,
            username: member.username,
            // (When somebody else joined is itself a position: not one from before the viewer's time.)
            ...(member.joinedAfter?.id && (member.userId === userId || sinceJoining(viewer, member.joinedAfter))
                ? { joinedAfter: plainPosition(member.joinedAfter) } : {}),
            ...positionsShownTo(member, viewer),
            ...(member.gone ? { gone: true } : {}),
            // The bot has no device and reads only what is addressed to it: a client leaves
            // it out when working out whether everyone in a group has seen something.
            ...(member.userId === BOT.id ? { bot: true } : {}),
        })),
        lastMessage: viewer && seesLastMessage(conversation, viewer)
            ? {
                id: conversation.lastMessage.id,
                from: conversation.lastMessage.from,
                fromName: conversation.lastMessage.fromName,
                preview: conversation.lastMessage.preview,
                timestamp: conversation.lastMessage.timestamp,
                ...(conversation.lastMessage.kind ? { kind: conversation.lastMessage.kind, data: conversation.lastMessage.data } : {}),
                ...(conversation.lastMessage.attachments ? { attachments: conversation.lastMessage.attachments } : {}),
            }
            : null,
        unreadCount,
    }
}

/** The id of every group the user is in — all of them, unlike the list of conversations. */
export const groupIdsOf = async userId =>
    (await Conversation.find({ kind: 'group', 'members.userId': userId }, { _id: 1 }).lean()).map(group => group._id)

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

// The condition under which the member entry `name` (an array filter) may take `position`
// at `path`: it is this user's, and stands before it. Never backwards.
const standsBefore = (name, userId, path, position) => ({
    [`${name}.userId`]: userId,
    $or: [
        { [`${name}.${path}`]: null },
        { [`${name}.${path}.ts`]: { $lt: position.ts } },
        { [`${name}.${path}.ts`]: position.ts, [`${name}.${path}.id`]: { $lt: position.id } },
    ],
})

const earlierPosition = (a, b) => (comparePositions(a, b) <= 0 ? a : b)

/**
 * Moves one member's `field` (readUpTo or deliveredUpTo) forward to `position`. Reading
 * something implies having received it, so `readUpTo` takes `deliveredUpTo` along.
 *
 * `publish`: whether everyone else may be told — false while the member is invisible, in
 * which case only their own, true positions move.
 *
 * All of it is one operation on the conversation. Resolves to:
 *   moved         whether the true `field` moved
 *   conversation  the conversation as it is afterwards (null if the user is not in it)
 *   publishedFrom where what others are told stood before, if it moved — the earlier of
 *                 the two when both did; undefined if nothing others can see changed
 */
export const advancePosition = async (conversationId, userId, field, position, { publish = true } = {}) => {
    const fields = field === 'readUpTo' ? ['deliveredUpTo', 'readUpTo'] : ['deliveredUpTo']
    const paths = [...fields, ...(publish ? fields.map(each => `published.${each}`) : [])]
    // One array filter per path: each moves only if it stands before `position`.
    // Sent through the driver itself: Mongoose would cast the array filters against the
    // schema and drop their `$or`, leaving every position free to move backwards.
    const before = await Conversation.collection.findOneAndUpdate(
        { _id: conversationId, 'members.userId': userId },
        { $set: Object.fromEntries(paths.map((path, index) => [`members.$[m${index}].${path}`, position])) },
        { arrayFilters: paths.map((path, index) => standsBefore(`m${index}`, userId, path, position)), returnDocument: 'before' },
    )
    const was = memberOf(before, userId)
    if (!was) return { moved: false, conversation: null }

    const stood = path => plainPosition(path.startsWith('published.') ? was.published?.[path.slice(10)] : was[path])
    const movedPaths = paths.filter(path => comparePositions(stood(path), position) < 0)
    const now = { ...was, published: { ...was.published } }
    for (const path of movedPaths) {
        if (path.startsWith('published.')) now.published[path.slice(10)] = position
        else now[path] = position
    }
    const publishedMoved = movedPaths.filter(path => path.startsWith('published.'))
    return {
        moved: movedPaths.includes(field),
        conversation: { ...before, members: before.members.map(member => (member === was ? now : member)) },
        ...(publishedMoved.length > 0 ? { publishedFrom: publishedMoved.map(stood).reduce(earlierPosition) } : {}),
    }
}

/**
 * Brings what others are told about a member up to the truth, in every conversation
 * they are in: what happens when someone stops being invisible. Resolves to
 * `{ conversation, publishedFrom }` (as `advancePosition` gives them) for each
 * conversation in which something others can see changed.
 */
export const publishPositions = async userId => {
    const conversations = await Conversation.find({ 'members.userId': userId }).lean()
    const changed = []
    for (const conversation of conversations) {
        const member = memberOf(conversation, userId)
        // Each published position is brought up to its own true one (they can differ:
        // read up to one message, received up to a later one). The true ones are there
        // already, so only what is published can move.
        let latest = null
        const from = []
        for (const field of ['readUpTo', 'deliveredUpTo']) {
            const truth = plainPosition(member[field])
            if (truth === null) continue
            const result = await advancePosition(conversation._id, userId, field, truth)
            if ('publishedFrom' in result) {
                latest = result.conversation
                from.push(result.publishedFrom)
            }
        }
        if (latest) changed.push({ conversation: latest, publishedFrom: from.reduce(earlierPosition) })
    }
    return changed
}

/** The text shown under a conversation's name in the list. */
export const previewOf = text => {
    const flat = String(text ?? '').trim().replace(/\s+/g, ' ')
    return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat
}
