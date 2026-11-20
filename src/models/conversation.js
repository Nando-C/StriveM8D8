import mongoose from 'mongoose'
import { ensureTtlIndex } from './ttl.js'

const position = new mongoose.Schema({ ts: Number, id: String }, { _id: false })

// One document per conversation. Its members live inside it (a group has at most 20), so
// "my conversations" is one query and moving a read position is one atomic update.
//
// The `members` list is the only thing that decides who may read or write here. The id
// of a direct conversation happens to contain two userIds, so that both sides can work it
// out without asking — but nothing is ever authorised by reading an id.
const conversationSchema = new mongoose.Schema({
    _id: String,
    kind: { type: String, required: true, enum: ['direct', 'group'] },
    name: String,
    /** Groups: who made it. Counted against their allowance of groups for as long as it exists. */
    createdBy: String,
    /** Groups: the userId of the member who may rename it and remove people. */
    admin: String,
    members: [{
        _id: false,
        userId: { type: String, required: true },
        /** A copy, for display: the member's identity may no longer exist. */
        username: { type: String, required: true },
        // Groups: the member sees only what comes after this — the position of the system
        // message that added them. Absent in direct chats and for a group's first members.
        joinedAfter: position,
        // How far this member has received and read: the truth, which only they are told
        // (their own unread counts depend on it)…
        deliveredUpTo: position,
        readUpTo: position,
        // …and what everyone else is told. The same, except while the member is
        // invisible: then these stand still, and catch up when they are visible again.
        published: new mongoose.Schema({ deliveredUpTo: position, readUpTo: position }, { _id: false }),
        /** Direct chats: this person's identity was removed; the chat is kept for the other. */
        gone: Boolean,
    }],
    lastMessage: new mongoose.Schema({
        id: String,
        from: String,
        fromName: String,
        preview: String,
        timestamp: Number,
        /** Only for a last message that is not text: its kind and structured content. */
        kind: String,
        data: mongoose.Schema.Types.Mixed,
    }, { _id: false }),
    lastActivityAt: { type: Date, default: Date.now },
})
// "The conversations of this user, most recently active first."
conversationSchema.index({ 'members.userId': 1, lastActivityAt: -1 })
// "How many groups has this user created?"
conversationSchema.index({ createdBy: 1 }, { sparse: true })

export const Conversation = mongoose.model('Conversation', conversationSchema)

/** A conversation is deleted `ttlHours` after its last message; 0 or undefined: never. */
export const ensureConversationIndexes = ({ ttlHours } = {}) =>
    ensureTtlIndex(Conversation, { field: 'lastActivityAt', name: 'conversation_expiry', ttlHours })
