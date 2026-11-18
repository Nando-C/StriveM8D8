import mongoose from 'mongoose'

export const INVITATION_LIFETIME_DAYS = 7

// A single-use code that lets one person register while sign-up is by invitation.
// Only the code's SHA-256 is stored; the document is deleted when the code is used.
const invitationSchema = new mongoose.Schema({
    codeHash: { type: String, required: true, unique: true },
    /** The `userId` of the administrator who created it. */
    createdBy: { type: String, required: true, index: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
})
// MongoDB removes the document once `expiresAt` has passed (checked about once a minute,
// so the code that accepts an invitation compares the date as well).
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const Invitation = mongoose.model('Invitation', invitationSchema)
