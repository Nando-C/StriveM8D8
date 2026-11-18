import mongoose from 'mongoose'

// Who somebody is. `userId` is the identity: it is random, never changes and is never
// given to anyone else. `username` is only its display name — unique among the identities
// that exist right now, but free to be claimed again once its owner is gone, by someone
// who then gets a different `userId`.
//
// A guest proves the name is theirs with a secret kept in their browser (`secretHash` is
// its SHA-256). An account proves it with a password, from any device.
/** The form a username is compared in. */
export const usernameKeyOf = username => String(username ?? '').toLowerCase()

const identitySchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    // The name in lower case: what makes it taken. "Alice" and "alice" are one name to
    // anybody reading a list of people, so they are one name here — whoever has it keeps
    // the spelling they chose, and nobody else can have another.
    usernameKey: {
        type: String,
        default() {
            return usernameKeyOf(this.username)
        },
    },
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
// Unique among the identities that have a key — which is all of them, once any stored
// before the key existed have been given theirs (see backfillUsernameKeys).
identitySchema.index({ usernameKey: 1 }, { unique: true, partialFilterExpression: { usernameKey: { $type: 'string' } } })

export const Identity = mongoose.model('Identity', identitySchema)

/**
 * Gives a key to identities stored before names were compared without regard to case.
 * Where two existing names differ only by case, the older keeps the name and the other
 * is left without a key: it cannot be found by name any more, and lapses or is deleted
 * like any other. Resolves to how many were left out that way.
 */
export const backfillUsernameKeys = async () => {
    const missing = await Identity.find({ usernameKey: { $exists: false } }, { username: 1 }).sort({ createdAt: 1 }).lean()
    let conflicts = 0
    for (const identity of missing) {
        try {
            await Identity.updateOne({ _id: identity._id }, { usernameKey: usernameKeyOf(identity.username) })
        } catch (error) {
            if (error?.code !== 11000) throw error
            conflicts += 1
        }
    }
    return conflicts
}
