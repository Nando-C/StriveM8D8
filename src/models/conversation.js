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
    createdBy: String,
    members: [{
        _id: false,
        userId: { type: String, required: true },
        /** A copy, for display: the member's identity may no longer exist. */
        username: { type: String, required: true },
        /** Groups: the member sees only what comes after this. Absent in direct chats. */
        joinedAfter: position,
        deliveredUpTo: position,
        readUpTo: position,
        /** Direct chats: this person's identity was removed; the chat is kept for the other. */
        gone: Boolean,
    }],
    lastMessage: new mongoose.Schema({
        id: String,
        from: String,
        fromName: String,
        preview: String,
        timestamp: Number,
    }, { _id: false }),
    lastActivityAt: { type: Date, default: Date.now },
})
// "The conversations of this user, most recently active first."
conversationSchema.index({ 'members.userId': 1, lastActivityAt: -1 })

export const Conversation = mongoose.model('Conversation', conversationSchema)

/** A conversation is deleted `ttlHours` after its last message; 0 or undefined: never. */
export const ensureConversationIndexes = ({ ttlHours } = {}) =>
    ensureTtlIndex(Conversation, { field: 'lastActivityAt', name: 'conversation_expiry', ttlHours })
