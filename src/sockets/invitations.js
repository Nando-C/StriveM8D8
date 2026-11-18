import { fingerprint, newSecret } from '../auth/secrets.js'
import { INVITATION_LIFETIME_DAYS, Invitation } from '../models/invitation.js'
import { isDocumentId, refuse } from './validation.js'

// Invitations, as administrators handle them. (Using one up is part of signing up: see
// `register` in session.js.) Each is a handler for session.js's `on`.

const MAX_OPEN_INVITATIONS = 50
const DAY = 24 * 60 * 60_000

export const createInvitation = async ({ user }) => {
    const open = await Invitation.countDocuments({ createdBy: user.userId, expiresAt: { $gt: new Date() } })
    if (open >= MAX_OPEN_INVITATIONS) refuse('Too many unused invitations: revoke some first')
    // The unique index is what makes a code single: make sure it exists before the write.
    await Invitation.init()
    const code = newSecret()
    const invitation = await Invitation.create({
        codeHash: fingerprint(code),
        createdBy: user.userId,
        expiresAt: new Date(Date.now() + INVITATION_LIFETIME_DAYS * DAY),
    })
    // The code is returned this once and cannot be read back later.
    return { id: invitation._id.toString(), code, expiresAt: invitation.expiresAt.getTime() }
}

export const listInvitations = async () => {
    const invitations = await Invitation.find({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean()
    return {
        invitations: invitations.map(invitation => ({
            id: invitation._id.toString(),
            createdAt: invitation.createdAt.getTime(),
            expiresAt: invitation.expiresAt.getTime(),
        })),
    }
}

export const revokeInvitation = async ({ payload }) => {
    if (!isDocumentId(payload.id)) refuse('Unknown invitation')
    const { deletedCount } = await Invitation.deleteOne({ _id: payload.id })
    if (deletedCount === 0) refuse('Unknown invitation')
    return {}
}
