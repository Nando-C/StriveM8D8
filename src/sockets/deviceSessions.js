import { fingerprint, newSecret } from '../auth/secrets.js'
import { Session } from '../models/session.js'

// The devices an account is signed in on: one stored session each, proved by a token only
// that device holds. Ending a session also ends whatever is connected with it — and any
// login that was still being completed on the strength of it.

const MAX_LABEL_LENGTH = 60
const MAX_SESSIONS_PER_ACCOUNT = 20

// Shown back to the account's owner only, but still stored: keep it short and printable.
const cleanLabel = value =>
    (typeof value === 'string' ? value : '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, MAX_LABEL_LENGTH)

export const createDeviceSessions = ({ presence }) => {
    // When a device session ("s:<id>") or everything a user had proved ("u:<userId>") was
    // last revoked. A login that began before that moment must not complete after it.
    const revokedAt = new Map()

    /** Whether a login for this user (and device session, if any) that began at `startedAt` is void by now. */
    const wasRevokedSince = (startedAt, userId, deviceSessionId) =>
        (revokedAt.get(`u:${userId}`) ?? 0) >= startedAt ||
        (deviceSessionId !== null && (revokedAt.get(`s:${deviceSessionId}`) ?? 0) >= startedAt)

    /**
     * The user's credentials have just changed, or the user is gone: no login of theirs
     * that is under way may complete. (Nothing stored is touched: see `end`.)
     */
    const revokeLoginsUnderWay = userId => {
        revokedAt.set(`u:${userId}`, Date.now())
    }

    /**
     * Deletes the matching device sessions of a user and disconnects whatever was using
     * them. `loginsUnderWay`: also void every login of theirs still being completed — for
     * when the reason is that their password is no longer what it was.
     */
    const end = async (userId, filter, { reason = 'Signed out', exceptSocketId = null, loginsUnderWay = false } = {}) => {
        // Before anything is waited for.
        if (loginsUnderWay) revokeLoginsUnderWay(userId)
        const sessions = await Session.find({ userId, ...filter }, { _id: 1 }).lean()
        const ids = new Set(sessions.map(session => session._id.toString()))
        const now = Date.now()
        for (const id of ids) revokedAt.set(`s:${id}`, now)
        await Session.deleteMany({ _id: { $in: sessions.map(session => session._id) } })

        const user = presence.users.get(userId)
        if (user) presence.revoke(user, { reason, only: entry => ids.has(entry.deviceSessionId), except: exceptSocketId })
        return ids.size
    }

    /** Stores a new session for a device. Resolves to its `token` (given out once) and its id. */
    const create = async (userId, label) => {
        const token = newSecret()
        const session = await Session.create({ tokenHash: fingerprint(token), userId, label: cleanLabel(label) })
        // Keep the newest few; a forgotten device's session would otherwise live as long as
        // it is unused. Tidying up, not part of signing in: a failure here fails nothing.
        try {
            const extra = await Session.find({ userId }, { _id: 1 })
                .sort({ lastUsedAt: -1, _id: -1 }).skip(MAX_SESSIONS_PER_ACCOUNT).lean()
            if (extra.length > 0) await end(userId, { _id: { $in: extra.map(doc => doc._id) } })
        } catch (error) {
            console.error("failed to trim old device sessions:", error.name)
        }
        return { token, deviceSessionId: session._id.toString() }
    }

    /** Forgets revocations older than `maxAgeMs`: no login takes that long. */
    const prune = (now, maxAgeMs) => {
        for (const [key, time] of revokedAt) if (now - time > maxAgeMs) revokedAt.delete(key)
    }

    return { create, end, revokeLoginsUnderWay, wasRevokedSince, prune }
}
