import mongoose from 'mongoose'

export const FILE_STATES = ['pending', 'attached', 'removing', 'discarded', 'unused']

const position = new mongoose.Schema({ ts: Number, id: String }, { _id: false })

// One document per upload. The bytes themselves are in object storage under `key`; the
// server never holds them.
//
// A file starts `pending` (a place reserved, an upload URL handed out), becomes
// `attached` when a message is sent with it, is `removing` while its object is being
// deleted, and ends `discarded` when the object is gone but what it cost must still
// count against today's allowances. `unused`: given up before anything was uploaded —
// kept, and counted, only until its upload URL can no longer be used; then, if nothing arrived, it has cost nothing.
//
// The upload URL writes to `uploadKey`. Sending the message copies the object to a key
// of its own (`key`), which no URL ever given out can write to: what a message carries
// cannot be replaced afterwards. Whatever arrives at `uploadKey` later is deleted.
const fileSchema = new mongoose.Schema({
    _id: String,
    /** The conversation it was uploaded for, and the only one it can be attached in. */
    conversationId: { type: String, required: true },
    /** The uploader's `userId`, and the address the request came from: both have a daily allowance. */
    uploader: { type: String, required: true },
    address: String,
    /** Where the object is in storage. Never sent to a client. */
    key: { type: String, required: true },
    /** Where its upload URL writes. Kept until that URL is certainly dead, then cleared. */
    uploadKey: String,
    /** While it is being attached: the copy being made, so that one left behind by a crash can be found. */
    copyKey: String,
    copyingSince: Date,
    name: { type: String, required: true },
    type: { type: String, required: true },
    size: { type: Number, required: true },
    // What the uploading client measured, so that a bubble has its shape before the file loads.
    width: Number,
    height: Number,
    durationMs: Number,
    /** A tiny blurred preview, as a data URL. */
    placeholder: String,
    state: { type: String, enum: FILE_STATES, default: 'pending' },
    // Once attached: the message it is in, and that message's position — which decides
    // who may download it, exactly as it decides who may read the message.
    messageId: String,
    attachedAt: position,
    createdAt: { type: Date, default: Date.now },
    /** When the message it is attached to expires. Absent: never. */
    expiresAt: Date,
})
// Today's uploads of one user, and of one address.
fileSchema.index({ uploader: 1, createdAt: 1 })
fileSchema.index({ address: 1, createdAt: 1 })
// The sweeps: pending uploads by age, attached files by expiry.
fileSchema.index({ state: 1, createdAt: 1 })
fileSchema.index({ expiresAt: 1 }, { sparse: true })
fileSchema.index({ conversationId: 1 })
// The files of one message; how many uploads someone has waiting.
fileSchema.index({ messageId: 1 }, { sparse: true })
fileSchema.index({ uploader: 1, state: 1 })
fileSchema.index({ uploadKey: 1 }, { sparse: true })
fileSchema.index({ copyKey: 1 }, { sparse: true })

export const File = mongoose.model('File', fileSchema)
