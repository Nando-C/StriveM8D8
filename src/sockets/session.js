import { randomUUID } from 'node:crypto'
import { createAttemptLimiter } from '../auth/attempts.js'
import { HasherBusyError, createPasswordHasher } from '../auth/passwords.js'
import {
    fingerprint, isSecret, newRecoveryCode, newSecret, normaliseRecoveryCode, sameString,
} from '../auth/secrets.js'
import { BOT } from '../bot.js'
import { conversationsFor } from '../conversations.js'
import { addressOfSocket } from '../clientAddress.js'
import { isDatabaseReady } from '../db.js'
import { Identity } from '../models/identity.js'
import { INVITATION_LIFETIME_DAYS, Invitation } from '../models/invitation.js'
import { Session } from '../models/session.js'
import { ownStatus } from './status.js'
import { NOT_LOGGED_IN, SLOW_DOWN, USERNAME_PATTERN, isObject, withAck } from './validation.js'

// Who somebody is, and proving it: guests, accounts, the devices an account is signed in
// on, and invitations. Everything here answers either with `loggedin` / `loginError`
// (for `login`) or through the event's acknowledgement, as { ok: true, … } or
// { ok: false, message }.

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const MAX_LABEL_LENGTH = 60
/** Connections one account may hold at once (devices and tabs). A guest holds one. */
const MAX_SOCKETS_PER_ACCOUNT = 5
const MAX_SESSIONS_PER_ACCOUNT = 20
const MAX_OPEN_INVITATIONS = 50
/** How many accounts the member directory lists. */
const MAX_DIRECTORY = 200
/** How long an idle guest keeps their name where no message expiry is configured. */
const DEFAULT_GUEST_IDLE_HOURS = 30 * 24
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

// Per socket.
const RATE_LIMITS = {
    // Each successful login is broadcast to every connected client.
    login: { limit: 5, windowMs: 10_000 },
    // These run a password hash, which is slow on purpose.
    credentials: { limit: 5, windowMs: 10_000 },
    account: { limit: 20, windowMs: 10_000 },
}

const IN_USE = 'Username already in use'
const RESERVED = 'That name is reserved'
const STARTING = 'Service is starting, try again'
const TOO_MANY_DEVICES = 'Too many devices connected at once'
const SESSION_ENDED = 'Your session has ended — sign in again'
const WRONG_PASSWORD = 'Wrong username or password'
const WRONG_RECOVERY = 'Wrong username or recovery code'
const PASSWORD_RULE = `Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`

// Thrown anywhere inside a handler to answer the client with a reason. Anything else
// that is thrown is a fault: it is logged by name and answered generically.
class Refusal extends Error {
    constructor(message, extra = {}) {
        super(message)
        this.extra = extra
    }
}
const refuse = (message, extra) => {
    throw new Refusal(message, extra)
}

const isPassword = value =>
    typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH && value.length <= MAX_PASSWORD_LENGTH

// Shown back to the account's owner only, but still stored: keep it short and printable.
const cleanLabel = value =>
    (typeof value === 'string' ? value : '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, MAX_LABEL_LENGTH)

const isDocumentId = value => typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)

const isDuplicateKey = error => error?.code === 11000

const waitText = ms => {
    const seconds = Math.ceil(ms / 1000)
    return seconds < 90 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`
}

export const createSessionHandlers = ({
    io, presence, settings, rateLimiter, onIdentityRemoved = async () => {}, onConversationsListed = async () => {},
}) => {
    const hasher = createPasswordHasher({ params: settings.passwordParams })
    // Failed sign-ins and recoveries, counted per address and per (address, username).
    const failuresByAddress = createAttemptLimiter({ freeFailures: 20 })
    const failuresByPair = createAttemptLimiter({ freeFailures: 5 })
    const adminNames = new Set(settings.adminUsernames)
    const guestIdleMs = (settings.messageTtlHours > 0 ? settings.messageTtlHours : DEFAULT_GUEST_IDLE_HOURS) * HOUR

    /** Sockets with a `login` in flight: a second one must not race the first. */
    const loggingIn = new Set()
    // When a device session ("s:<id>") or all of a user's sessions ("u:<userId>") were
    // last revoked. A login that began before that moment must not complete after it.
    const revokedAt = new Map()
    const wasRevokedSince = (startedAt, userId, deviceSessionId) =>
        (revokedAt.get(`u:${userId}`) ?? 0) >= startedAt ||
        (deviceSessionId !== null && (revokedAt.get(`s:${deviceSessionId}`) ?? 0) >= startedAt)

    const addressOf = socket => addressOfSocket(socket, settings.trustedProxyHops)
    const allowed = (socket, key) => rateLimiter.allow(socket.id, key, RATE_LIMITS[key])
    const allowedForAddress = (socket, key) => rateLimiter.allow(`address:${addressOf(socket)}`, key, settings.limits[key])

    const requireDatabase = () => {
        if (!isDatabaseReady()) refuse(STARTING, { retryable: true })
    }

    // The unique indexes are what stop two people getting one name: make sure they exist
    // before the first write. Cached by Mongoose after the first call.
    const indexesReady = () => Promise.all([Identity.init(), Session.init(), Invitation.init()])

    /**
     * Runs one password or recovery-code check for an (address, username), under the
     * guessing limits. `attempt` resolves to something truthy when the guess was right;
     * that is what this resolves to as well. The attempt is counted from the moment it
     * starts, not from when it fails: the check is slow on purpose, and guesses sent all
     * at once must not all get in before the first has been counted.
     */
    const checkGuess = async (socket, username, attempt) => {
        const address = addressOf(socket)
        const pair = `${address}|${username}`
        const tooMany = wait => refuse(`Too many attempts. Try again in ${waitText(wait)}`, { retryAfterMs: wait })

        const addressWait = failuresByAddress.begin(address)
        if (addressWait > 0) tooMany(addressWait)
        const pairWait = failuresByPair.begin(pair)
        if (pairWait > 0) {
            failuresByAddress.end(address, { failed: false })
            tooMany(pairWait)
        }

        // Something that goes wrong while checking (the database, a full hashing queue)
        // is not a wrong guess: the attempt is released without being counted.
        let failed = false
        try {
            const result = await attempt()
            failed = !result
            // The address keeps its count: one right answer must not reset guessing at other names.
            if (result) failuresByPair.clear(pair)
            return result
        } finally {
            failuresByAddress.end(address, { failed })
            failuresByPair.end(pair, { failed })
        }
    }

    const hashRecoveryCode = code => hasher.hash(normaliseRecoveryCode(code))

    const createDeviceSession = async (userId, label) => {
        const token = newSecret()
        const session = await Session.create({ tokenHash: fingerprint(token), userId, label: cleanLabel(label) })
        // Keep the newest few; a forgotten device's session would otherwise live as long as it is unused.
        const extra = await Session.find({ userId }, { _id: 1 })
            .sort({ lastUsedAt: -1, _id: -1 }).skip(MAX_SESSIONS_PER_ACCOUNT).lean()
        if (extra.length > 0) await endDeviceSessions(userId, { _id: { $in: extra.map(doc => doc._id) } })
        return { token, deviceSessionId: session._id.toString() }
    }

    /** Deletes the matching device sessions of a user and disconnects whatever was using them. */
    const endDeviceSessions = async (userId, filter, { reason = 'Signed out', exceptSocketId = null } = {}) => {
        const sessions = await Session.find({ userId, ...filter }, { _id: 1 }).lean()
        const ids = new Set(sessions.map(session => session._id.toString()))
        const now = Date.now()
        for (const id of ids) revokedAt.set(`s:${id}`, now)
        await Session.deleteMany({ _id: { $in: sessions.map(session => session._id) } })

        const user = presence.users.get(userId)
        if (user) presence.revoke(user, { reason, only: entry => ids.has(entry.deviceSessionId), except: exceptSocketId })
        return ids.size
    }

    /**
     * Removes an identity and everything that belongs to it, and disconnects it. The one
     * routine used by account deletion and by guest expiry, so both tidy up the same way.
     * `onlyIf` is an extra condition checked in the same database operation as the delete.
     */
    const removeIdentity = async (userId, { reason, onlyIf = {}, keepSocketId = null } = {}) => {
        const removed = await Identity.findOneAndDelete({ userId, ...onlyIf }).lean()
        if (!removed) return false
        revokedAt.set(`u:${userId}`, Date.now())
        await Promise.all([Session.deleteMany({ userId }), Invitation.deleteMany({ createdBy: userId })])

        const user = presence.users.get(userId)
        if (user) {
            presence.revoke(user, { reason, except: keepSocketId })
            // The socket that asked stays connected, but is nobody now.
            if (keepSocketId !== null) presence.detach(keepSocketId)
        }
        // Their conversations are told, and the member directory (where there is one).
        await onIdentityRemoved(userId)
        if (removed.kind === 'account') tellDirectory('memberLeft', { userId })
        return true
    }

    // ---------- the member directory
    //
    // Where it is switched on, accounts are shown every other account, online or not:
    // otherwise nobody could start a conversation with someone who is not connected at
    // that moment. It goes to signed-in accounts only, and is capped.
    const directoryOn = settings.memberDirectory === 'all'
    const seesDirectory = user => directoryOn && user.kind === 'account'

    const directory = async () => {
        const accounts = await Identity.find({ kind: 'account' }, { userId: 1, username: 1 })
            .sort({ username: 1 }).limit(MAX_DIRECTORY).lean()
        return accounts.map(account => ({ userId: account.userId, username: account.username, kind: 'account' }))
    }

    const tellDirectory = (event, payload) => {
        if (!directoryOn) return
        const sockets = [...presence.users.values()].filter(seesDirectory).flatMap(user => [...user.sockets.keys()])
        if (sockets.length > 0) io.to(sockets).emit(event, payload)
    }

    // Completes a login on a socket that has just been attached: everything the client
    // needs to draw itself, in one event. If that cannot be gathered the login is undone,
    // so the client is never left logged in with half a picture.
    const sendLoggedIn = async (socket, user, sessionToken, extra = {}, { undoOnFailure = true } = {}) => {
        let conversations, members
        try {
            conversations = await conversationsFor(user.userId)
            if (seesDirectory(user)) members = await directory()
        } catch (error) {
            if (undoOnFailure) presence.detach(socket.id)
            throw error
        }
        if (!socket.connected) return false
        socket.emit('loggedin', {
            userId: user.userId,
            username: user.username,
            kind: user.kind,
            admin: user.admin,
            sessionToken,
            // What this user has chosen to show; nobody else is sent this.
            ownStatus: ownStatus(user),
            // Everyone who can be seen. (Not this user, if they are invisible.)
            onlineUsers: presence.getOnlineUsers(),
            conversations,
            ...(members === undefined ? {} : { members }),
            ...extra,
        })
        // Not part of logging in, and not allowed to fail it.
        onConversationsListed(user.userId, conversations)
            .catch(error => console.error("failed to record what a login delivered:", error.name))
        return true
    }

    // ---------- login

    const loginAsGuest = async (socket, username, payload) => {
        // The bot's name is reserved even where the bot is switched off: otherwise
        // someone could pose as it, or read the conversations people had with it.
        if (username === BOT.username) refuse(IN_USE)
        if (!settings.guests) refuse('Guest access is off — sign in with an account')
        if (adminNames.has(username)) refuse(RESERVED)
        requireDatabase()
        await indexesReady()

        let identity = await Identity.findOne({ username }).lean()
        let reservation = null
        if (!identity) {
            if (!allowedForAddress(socket, 'newGuestsPerAddress')) {
                refuse('Too many new names from this network, try again later')
            }
            reservation = newSecret()
            try {
                const created = await Identity.create({
                    userId: randomUUID(), username, kind: 'guest', secretHash: fingerprint(reservation),
                })
                identity = created.toObject()
            } catch (error) {
                // Someone else took the name between the lookup and the write.
                if (isDuplicateKey(error)) refuse(IN_USE)
                throw error
            }
        } else if (identity.kind === 'account') {
            refuse('That name belongs to an account — sign in')
        } else if (!isSecret(payload.reservation) || !sameString(fingerprint(payload.reservation), identity.secretHash)) {
            refuse(IN_USE)
        } else {
            await Identity.updateOne({ userId: identity.userId }, { lastSeenAt: new Date() })
        }
        // A name reserved a moment ago whose secret never reaches the browser is a name
        // nobody can ever use — its own owner included, until it lapses. So if this login
        // does not get as far as delivering the secret, the reservation is undone.
        const undoReservation = async () => {
            if (reservation === null) return
            presence.detach(socket.id)
            await Identity.deleteOne({ userId: identity.userId, kind: 'guest', secretHash: identity.secretHash }).catch(() => {})
        }
        if (!socket.connected) {
            await undoReservation()
            return
        }

        // A guest holds one connection: coming back on a new one takes over from the old.
        const online = presence.users.get(identity.userId)
        const replaceSocketId = online ? online.sockets.keys().next().value ?? null : null
        const { user, sessionToken } = presence.attach(socket, identity, { replaceSocketId })
        let delivered = false
        try {
            delivered = await sendLoggedIn(socket, user, sessionToken, reservation === null ? {} : { reservation })
        } finally {
            if (!delivered) await undoReservation()
        }
    }

    // Shared end of both account logins. `deviceSession` is the stored session being
    // resumed, or null to create one.
    const completeAccountLogin = async (socket, identity, payload, startedAt, deviceSession) => {
        const online = presence.users.get(identity.userId)
        // A reconnecting device names its previous connection, which is then replaced
        // rather than counted as one more device. Not a credential: it is only honoured
        // alongside a valid password or session.
        const replaceSocketId = online && isSecret(payload.sessionToken)
            ? [...online.sockets].find(([, entry]) => entry.sessionToken === payload.sessionToken)?.[0] ?? null
            : null
        if (online && online.sockets.size - (replaceSocketId === null ? 0 : 1) >= MAX_SOCKETS_PER_ACCOUNT) {
            refuse(TOO_MANY_DEVICES)
        }

        const created = deviceSession === null ? await createDeviceSession(identity.userId, payload.deviceLabel) : null
        const deviceSessionId = created?.deviceSessionId ?? deviceSession._id.toString()
        await Identity.updateOne({ userId: identity.userId }, { lastSeenAt: new Date() })

        // From here to `attach` nothing waits, so what is checked now still holds then.
        // A session created above that will not be handed over is removed again: nobody
        // received its token, so nobody could ever use it, and it would only sit in the
        // account's list of devices.
        const abandon = async () => {
            if (created) await Session.deleteOne({ _id: deviceSessionId })
        }
        if (wasRevokedSince(startedAt, identity.userId, deviceSessionId)) {
            await abandon()
            // The password was changed or reset, or this device signed out, while this
            // login was under way: whatever it proved is no longer good enough.
            refuse(created ? WRONG_PASSWORD : SESSION_ENDED, created ? {} : { sessionEnded: true })
        }
        if (!socket.connected) {
            await abandon()
            return
        }
        // Counted again: several logins that started together all saw room for themselves.
        const nowOnline = presence.users.get(identity.userId)
        const replacing = nowOnline?.sockets.has(replaceSocketId) ? 1 : 0
        if (nowOnline && nowOnline.sockets.size - replacing >= MAX_SOCKETS_PER_ACCOUNT) {
            await abandon()
            refuse(TOO_MANY_DEVICES)
        }
        const { user, sessionToken } = presence.attach(socket, identity, { deviceSessionId, replaceSocketId })
        await sendLoggedIn(socket, user, sessionToken, created ? { session: created.token } : {})
    }

    const loginWithPassword = async (socket, username, payload, startedAt) => {
        if (typeof payload.password !== 'string' || payload.password.length > MAX_PASSWORD_LENGTH) refuse(WRONG_PASSWORD)
        requireDatabase()
        const identity = await checkGuess(socket, username, async () => {
            const found = await Identity.findOne({ username, kind: 'account' }).lean()
            // Verified even when there is no such account, so both cases take the same time
            // and get the same answer.
            const matches = await hasher.verify(payload.password, found?.passwordHash ?? null)
            return found && matches ? found : null
        })
        if (!identity) refuse(WRONG_PASSWORD)
        await completeAccountLogin(socket, identity, payload, startedAt, null)
    }

    const resumeSession = async (socket, payload, startedAt) => {
        if (!isSecret(payload.session)) refuse(SESSION_ENDED, { sessionEnded: true })
        requireDatabase()

        const deviceSession = await Session.findOneAndUpdate(
            { tokenHash: fingerprint(payload.session) }, { lastUsedAt: new Date() },
        ).lean()
        const identity = deviceSession && await Identity.findOne({ userId: deviceSession.userId, kind: 'account' }).lean()
        if (!identity) refuse(SESSION_ENDED, { sessionEnded: true })
        await completeAccountLogin(socket, identity, payload, startedAt, deviceSession)
    }

    const login = async (socket, payload) => {
        const startedAt = Date.now()
        const username = typeof payload.username === 'string' ? payload.username.trim() : ''

        const current = presence.bySocket.get(socket.id)
        if (current) {
            // The same socket asking again for the name it already has changes nothing.
            const repeat = payload.session === undefined && payload.password === undefined && username === current.username
            if (!repeat) refuse('Already logged in')
            requireDatabase()
            await sendLoggedIn(socket, current, current.sockets.get(socket.id).sessionToken, {}, { undoOnFailure: false })
            return
        }

        if (payload.session !== undefined) return resumeSession(socket, payload, startedAt)
        if (!USERNAME_PATTERN.test(username)) refuse('Invalid username')
        if (payload.password !== undefined) return loginWithPassword(socket, username, payload, startedAt)
        return loginAsGuest(socket, username, payload)
    }

    // ---------- accounts

    const register = async ({ socket, user, payload }) => {
        const username = typeof payload.username === 'string' ? payload.username.trim() : ''
        if (!USERNAME_PATTERN.test(username)) refuse('Invalid username')
        if (!isPassword(payload.password)) refuse(PASSWORD_RULE)
        if (username === BOT.username) refuse(IN_USE)
        // A signed-in guest may turn their own name into an account; nothing else may
        // register from a socket that is already somebody.
        const isOwnGuestName = user?.kind === 'guest' && user.username === username
        if (user && !isOwnGuestName) refuse('Already logged in')
        if (settings.signupMode === 'closed') refuse('Sign-up is closed')

        // Administrator names can be registered in one way only: with the bootstrap code.
        const asAdmin = adminNames.has(username)
        if (asAdmin && (settings.bootstrapCode === null || !sameString(payload.bootstrapCode, settings.bootstrapCode))) {
            refuse(RESERVED)
        }
        const needsInvitation = settings.signupMode === 'invite' && !asAdmin
        if (needsInvitation && !isSecret(payload.invitation)) refuse('An invitation is needed to sign up')

        if (!allowedForAddress(socket, 'registrationsPerAddress')) {
            refuse('Too many sign-ups from this network, try again later')
        }
        await indexesReady()

        const existing = await Identity.findOne({ username }).lean()
        const upgrading = existing?.kind === 'guest' && !asAdmin && (
            (isOwnGuestName && user.userId === existing.userId) ||
            (isSecret(payload.reservation) && sameString(fingerprint(payload.reservation), existing.secretHash))
        )
        if (existing && !upgrading) refuse(IN_USE)

        const invitationFilter = () => ({ codeHash: fingerprint(payload.invitation), expiresAt: { $gt: new Date() } })
        const INVALID_INVITATION = 'That invitation is not valid any more'
        // Checked before the (slow) hashing, consumed after it.
        if (needsInvitation && !await Invitation.exists(invitationFilter())) refuse(INVALID_INVITATION)

        const recoveryCode = newRecoveryCode()
        const [passwordHash, recoveryHash] = await Promise.all([
            hasher.hash(payload.password), hashRecoveryCode(recoveryCode),
        ])

        // Deleting the invitation is what makes it single-use: only one request gets it back.
        const invitation = needsInvitation ? await Invitation.findOneAndDelete(invitationFilter()).lean() : null
        if (needsInvitation && !invitation) refuse(INVALID_INVITATION)

        let identity
        try {
            identity = upgrading
                ? await Identity.findOneAndUpdate(
                    { userId: existing.userId, kind: 'guest' },
                    { $set: { kind: 'account', passwordHash, recoveryHash, lastSeenAt: new Date() }, $unset: { secretHash: 1 } },
                    { returnDocument: 'after' },
                ).lean()
                : (await Identity.create({
                    userId: randomUUID(), username, kind: 'account', admin: asAdmin, passwordHash, recoveryHash,
                })).toObject()
        } catch (error) {
            if (!isDuplicateKey(error)) throw error
            identity = null
        }
        if (!identity) {
            // The name went to someone else in the meantime: the invitation was not used.
            if (invitation) await Invitation.create(invitation).catch(() => {})
            refuse(IN_USE)
        }

        const { token, deviceSessionId } = await createDeviceSession(identity.userId, payload.deviceLabel)

        // An upgraded guest who is connected is now an account. This socket, if it is
        // theirs, carries on under the new device session; any other is signed out.
        const online = presence.users.get(identity.userId)
        if (online) {
            // Whoever can see them now sees an account.
            presence.update(online, changing => {
                changing.kind = 'account'
            })
            const own = online.sockets.get(socket.id)
            if (own) own.deviceSessionId = deviceSessionId
            presence.revoke(online, { reason: 'This name is now an account — sign in', except: socket.id })
        }
        tellDirectory('memberJoined', { userId: identity.userId, username: identity.username, kind: 'account' })
        return { session: token, recoveryCode, kind: 'account', admin: identity.admin === true }
    }

    const resetPassword = async ({ socket, payload }) => {
        const username = typeof payload.username === 'string' ? payload.username.trim() : ''
        if (!USERNAME_PATTERN.test(username) || typeof payload.recoveryCode !== 'string' || payload.recoveryCode.length > 100) {
            refuse(WRONG_RECOVERY)
        }
        if (!isPassword(payload.newPassword)) refuse(PASSWORD_RULE)
        const identity = await checkGuess(socket, username, async () => {
            const found = await Identity.findOne({ username, kind: 'account' }).lean()
            const matches = await hasher.verify(normaliseRecoveryCode(payload.recoveryCode), found?.recoveryHash ?? null)
            return found && matches ? found : null
        })
        if (!identity) refuse(WRONG_RECOVERY)

        // A recovery code works once: a new one replaces it.
        const recoveryCode = newRecoveryCode()
        const [passwordHash, recoveryHash] = await Promise.all([
            hasher.hash(payload.newPassword), hashRecoveryCode(recoveryCode),
        ])
        await Identity.updateOne({ userId: identity.userId }, { passwordHash, recoveryHash })
        revokedAt.set(`u:${identity.userId}`, Date.now())
        await endDeviceSessions(identity.userId, {}, { reason: 'The password was reset' })
        return { recoveryCode }
    }

    // Checks the signed-in account's own password, with the same guessing limits as sign-in.
    const confirmPassword = async (socket, user, password) => {
        if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) refuse('Wrong password')
        const right = await checkGuess(socket, user.username, async () => {
            const identity = await Identity.findOne({ userId: user.userId, kind: 'account' }).lean()
            return Boolean(identity) && await hasher.verify(password, identity.passwordHash ?? null)
        })
        if (!right) refuse('Wrong password')
    }

    const changePassword = async ({ socket, user, entry, payload }) => {
        if (!isPassword(payload.newPassword)) refuse(PASSWORD_RULE)
        await confirmPassword(socket, user, payload.currentPassword)

        const passwordHash = await hasher.hash(payload.newPassword)
        await Identity.updateOne({ userId: user.userId }, { passwordHash })
        // A sign-in with the old password that is still being completed must not finish
        // after this: only this connection's own session carries on.
        revokedAt.set(`u:${user.userId}`, Date.now())
        // Every other device is signed out; this one carries on.
        await endDeviceSessions(
            user.userId,
            { _id: { $ne: entry.deviceSessionId } },
            { reason: 'The password was changed', exceptSocketId: socket.id },
        )
        return {}
    }

    const listSessions = async ({ user, entry }) => {
        const sessions = await Session.find({ userId: user.userId }).sort({ lastUsedAt: -1, _id: -1 }).lean()
        return {
            sessions: sessions.map(session => ({
                id: session._id.toString(),
                label: session.label,
                createdAt: session.createdAt.getTime(),
                lastUsedAt: session.lastUsedAt.getTime(),
                current: session._id.toString() === entry.deviceSessionId,
            })),
        }
    }

    const revokeSession = async ({ user, payload }) => {
        if (!isDocumentId(payload.id)) refuse('Unknown device')
        const ended = await endDeviceSessions(user.userId, { _id: payload.id }, { reason: 'Signed out from another device' })
        if (ended === 0) refuse('Unknown device')
        return {}
    }

    // This device only. The connection stays open, logged out, so the page can show the
    // entry screen without reconnecting; other tabs sharing the device session are closed.
    const logout = async ({ socket, user, entry }) => {
        if (user.kind === 'account' && entry.deviceSessionId !== null && isDatabaseReady()) {
            await endDeviceSessions(user.userId, { _id: entry.deviceSessionId }, { exceptSocketId: socket.id })
        }
        presence.detach(socket.id)
        return {}
    }

    const deleteAccount = async ({ socket, user, payload }) => {
        await confirmPassword(socket, user, payload.password)
        await removeIdentity(user.userId, { reason: 'The account was deleted', keepSocketId: socket.id })
        return {}
    }

    // ---------- invitations (administrators)

    const createInvitation = async ({ user }) => {
        const open = await Invitation.countDocuments({ createdBy: user.userId, expiresAt: { $gt: new Date() } })
        if (open >= MAX_OPEN_INVITATIONS) refuse('Too many unused invitations: revoke some first')
        await indexesReady()
        const code = newSecret()
        const invitation = await Invitation.create({
            codeHash: fingerprint(code),
            createdBy: user.userId,
            expiresAt: new Date(Date.now() + INVITATION_LIFETIME_DAYS * DAY),
        })
        // The code is returned this once and cannot be read back later.
        return { id: invitation._id.toString(), code, expiresAt: invitation.expiresAt.getTime() }
    }

    const listInvitations = async () => {
        const invitations = await Invitation.find({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean()
        return {
            invitations: invitations.map(invitation => ({
                id: invitation._id.toString(),
                createdAt: invitation.createdAt.getTime(),
                expiresAt: invitation.expiresAt.getTime(),
            })),
        }
    }

    const revokeInvitation = async ({ payload }) => {
        if (!isDocumentId(payload.id)) refuse('Unknown invitation')
        const { deletedCount } = await Invitation.deleteOne({ _id: payload.id })
        if (deletedCount === 0) refuse('Unknown invitation')
        return {}
    }

    // ---------- wiring

    const answerFor = (event, error) => {
        if (error instanceof Refusal) return { message: error.message, ...error.extra }
        if (error instanceof HasherBusyError) return { message: 'The server is busy, try again in a moment', retryable: true }
        // The name only: driver messages can carry connection details.
        console.error(`${event} failed:`, error?.name)
        return { message: 'Something went wrong, try again', retryable: true }
    }

    const registerOn = socket => {
        socket.on('login', async payload => {
            if (!allowed(socket, 'login')) {
                socket.emit('loginError', { message: SLOW_DOWN })
                return
            }
            if (loggingIn.has(socket.id)) {
                socket.emit('loginError', { message: 'Already signing in' })
                return
            }
            loggingIn.add(socket.id)
            try {
                await login(socket, isObject(payload) ? payload : {})
            } catch (error) {
                socket.emit('loginError', answerFor('login', error))
            } finally {
                loggingIn.delete(socket.id)
            }
        })

        // who: 'anyone' | 'signedIn' | 'account' | 'admin'
        const on = (event, { who, limit = 'account', database = true }, handler) => {
            socket.on(event, async (rawPayload, rawAck) => {
                const { payload, reply } = withAck(rawPayload, rawAck)
                const fail = message => reply({ ok: false, message })

                if (!allowed(socket, limit)) return fail(SLOW_DOWN)
                const user = presence.bySocket.get(socket.id) ?? null
                if (who !== 'anyone' && user === null) return fail(NOT_LOGGED_IN)
                if ((who === 'account' || who === 'admin') && user.kind !== 'account') return fail('Only for accounts')
                if (who === 'admin' && !user.admin) return fail('Only for administrators')
                try {
                    if (database) requireDatabase()
                    const entry = user?.sockets.get(socket.id) ?? null
                    const result = await handler({ socket, user, entry, payload: isObject(payload) ? payload : {} })
                    reply({ ok: true, ...result })
                } catch (error) {
                    reply({ ok: false, ...answerFor(event, error) })
                }
            })
        }

        on('register', { who: 'anyone', limit: 'credentials' }, register)
        on('resetPassword', { who: 'anyone', limit: 'credentials' }, resetPassword)
        on('changePassword', { who: 'account', limit: 'credentials' }, changePassword)
        on('deleteAccount', { who: 'account', limit: 'credentials' }, deleteAccount)
        on('listSessions', { who: 'account' }, listSessions)
        on('revokeSession', { who: 'account' }, revokeSession)
        // Works without the database too: a guest's logout touches nothing stored.
        on('logout', { who: 'signedIn', database: false }, logout)
        on('createInvitation', { who: 'admin' }, createInvitation)
        on('listInvitations', { who: 'admin' }, listInvitations)
        on('revokeInvitation', { who: 'admin' }, revokeInvitation)
    }

    /**
     * Housekeeping, run every hour: marks everyone connected as seen, removes guests idle
     * for longer than the configured lifetime, and forgets old in-memory records.
     */
    const runMaintenance = async ({ now = Date.now() } = {}) => {
        failuresByAddress.prune()
        failuresByPair.prune()
        for (const [key, time] of revokedAt) if (now - time > HOUR) revokedAt.delete(key)
        if (!isDatabaseReady()) return { removedGuests: 0 }

        const online = [...presence.users.values()].filter(user => user.kind !== 'bot')
        if (online.length > 0) {
            await Identity.updateMany({ userId: { $in: online.map(user => user.userId) } }, { lastSeenAt: new Date(now) })
            const sessionIds = online.flatMap(user => [...user.sockets.values()].map(entry => entry.deviceSessionId)).filter(Boolean)
            if (sessionIds.length > 0) await Session.updateMany({ _id: { $in: sessionIds } }, { lastUsedAt: new Date(now) })
        }

        const idleSince = { $lt: new Date(now - guestIdleMs) }
        const idle = await Identity.find({ kind: 'guest', lastSeenAt: idleSince }, { userId: 1 }).limit(1000).lean()
        let removedGuests = 0
        for (const { userId } of idle) {
            // Never someone who is connected; and the condition is re-checked by the delete
            // itself, in case they came back a moment ago.
            if (presence.users.has(userId)) continue
            if (await removeIdentity(userId, { reason: 'This guest name expired', onlyIf: { kind: 'guest', lastSeenAt: idleSince } })) {
                removedGuests += 1
            }
        }
        return { removedGuests }
    }

    return { registerOn, runMaintenance, hasherStats: hasher.stats }
}
