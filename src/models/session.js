import mongoose from 'mongoose'

export const SESSION_LIFETIME_DAYS = 30

// One per device an account is signed in on. The device holds the token; only its SHA-256
// is stored. Used at least once every 30 days, a session never ends by itself.
const sessionSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    // Chosen by the device ("Firefox on Linux"), shown only to the account's owner.
    label: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: Date.now },
})
sessionSchema.index({ lastUsedAt: 1 }, { expireAfterSeconds: SESSION_LIFETIME_DAYS * 24 * 3600 })

export const Session = mongoose.model('Session', sessionSchema)
