import mongoose from 'mongoose'

// Who somebody is. `userId` is the identity: it is random, never changes and is never
// given to anyone else. `username` is only its display name — unique among the identities
// that exist right now, but free to be claimed again once its owner is gone, by someone
// who then gets a different `userId`.
//
// A guest proves the name is theirs with a secret kept in their browser (`secretHash` is
// its SHA-256). An account proves it with a password, from any device.
const identitySchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    kind: { type: String, required: true, enum: ['guest', 'account'] },
    // Set in exactly one way: registering a reserved administrator name with the bootstrap code.
    admin: { type: Boolean, default: false },
    secretHash: String,
    passwordHash: String,
    recoveryHash: String,
    // What the user has chosen to show (see status.js). Stored, so that it is the same
    // after a reload and on every device.
    status: { type: String, enum: ['online', 'away', 'dnd', 'invisible'], default: 'online' },
    statusText: { type: String, default: '' },
    /** When `statusText` clears itself, if it does. */
    statusClearAt: Date,
    createdAt: { type: Date, default: Date.now },
    // Refreshed at login and while connected. Idle guests are removed by the application's
    // own sweep, not by a TTL index: removal has to tidy up after the identity as well.
    lastSeenAt: { type: Date, default: Date.now },
})
identitySchema.index({ kind: 1, lastSeenAt: 1 })

export const Identity = mongoose.model('Identity', identitySchema)
