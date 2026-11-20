import { randomUUID } from 'node:crypto'
import { HasherBusyError, createPasswordHasher } from '../auth/passwords.js'
import {
    fingerprint, isSecret, newRecoveryCode, newSecret, normaliseRecoveryCode, sameString,
} from '../auth/secrets.js'
import { BOT } from '../bot.js'
import { conversationsFor, groupIdsOf } from '../conversations.js'
import { addressOfSocket } from '../clientAddress.js'
import { isDatabaseReady, isDuplicateKey } from '../db.js'
import { Identity, usernameKeyOf } from '../models/identity.js'
import { Invitation } from '../models/invitation.js'
import { Session } from '../models/session.js'
import { createDeviceSessions } from './deviceSessions.js'
import { createGuessLimiter } from './guesses.js'
import { createInvitation, listInvitations, revokeInvitation } from './invitations.js'
import { ownStatus } from './status.js'
import {
    NOT_LOGGED_IN, Refusal, SLOW_DOWN, USERNAME_PATTERN, isDocumentId, isObject, refuse, withAck,
} from './validation.js'

// Who somebody is, and proving it: guests and accounts. (The devices an account is signed
// in on are in deviceSessions.js, the limits on guessing in guesses.js, invitations in
// invitations.js.) Everything here answers either with `loggedin` / `loginError`
// (for `login`) or through the event's acknowledgement, as { ok: true, … } or
// { ok: false, message }.

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
/** Connections one account may hold at once (devices and tabs). A guest holds one. */
const MAX_SOCKETS_PER_ACCOUNT = 5
/** How many accounts the member directory lists. */
const MAX_DIRECTORY = 200
/** How long an idle guest keeps their name where no message expiry is configured. */
const DEFAULT_GUEST_IDLE_HOURS = 30 * 24
const HOUR = 60 * 60_000

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

const isPassword = value =>
    typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH && value.length <= MAX_PASSWORD_LENGTH

/** The username a request names, trimmed; '' if it names none. (Whether it is a valid one is the caller's to check.) */
const usernameIn = payload => (typeof payload.username === 'string' ? payload.username.trim() : '')

/** Whether a request carries the secret that holds this guest's name. */
const holdsReservation = (payload, guest) =>
    isSecret(payload.reservation) && sameString(fingerprint(payload.reservation), guest.secretHash)

export const createSessionHandlers = ({
    presence, settings, rateLimiter, onIdentityRemoved = async () => {}, onConversationsListed = async () => {},
}) => {
    const hasher = createPasswordHasher({ params: settings.passwordParams })
    // Compared as every name is: without regard to case.
    const adminNames = new Set(settings.adminUsernames.map(usernameKeyOf))
    const isAdminName = username => adminNames.has(usernameKeyOf(username))
    const isBotName = username => usernameKeyOf(username) === usernameKeyOf(BOT.username)
    const guestIdleMs = (settings.messageTtlHours > 0 ? settings.messageTtlHours : DEFAULT_GUEST_IDLE_HOURS) * HOUR

    /** Sockets with a `login` in flight: a second one must not race the first. */
    const loggingIn = new Set()
    const addressOf = socket => addressOfSocket(socket, settings.trustedProxyHops)
    const allowed = rateLimiter.perSocket(RATE_LIMITS)
    const { checkGuess, prune: pruneGuesses } = createGuessLimiter({ addressOf })
    const devices = createDeviceSessions({ presence })
    const allowedForAddress = (socket, key) => rateLimiter.allow(`address:${addressOf(socket)}`, key, settings.limits[key])

    const requireDatabase = () => {
        if (!isDatabaseReady()) refuse(STARTING, { retryable: true })
    }

    // The unique indexes are what stop two people getting one name: make sure they exist
    // before the first write. Cached by Mongoose after the first call.
    const indexesReady = () => Promise.all([Identity.init(), Session.init(), Invitation.init()])

    /** A password's hash, and a new recovery code with its hash: what an account is given together. */
    const newCredentials = async password => {
        const recoveryCode = newRecoveryCode()
        const [passwordHash, recoveryHash] = await Promise.all([
            hasher.hash(password), hasher.hash(normaliseRecoveryCode(recoveryCode)),
        ])
        return { recoveryCode, passwordHash, recoveryHash }
    }

    /**
     * The account called `username`, if `secret` is right for it (`hashField` says which
     * of its secrets); null otherwise. One guess, under the guessing limits. Verified even
     * when there is no such account, so both cases take the same time and get the same answer.
     */
    const accountIfRight = (socket, username, secret, hashField) => checkGuess(socket, username, async () => {
        const found = await Identity.findOne({ usernameKey: usernameKeyOf(username), kind: 'account' }).lean()
        const matches = await hasher.verify(secret, found?.[hashField] ?? null)
        return found && matches ? found : null
    })

    /**
     * Removes an identity and everything that belongs to it, and disconnects it. The one
     * routine used by account deletion and by guest expiry, so both tidy up the same way.
     * `onlyIf` is an extra condition checked in the same database operation as the delete.
     */
    const removeIdentity = async (userId, { reason, onlyIf = {}, keepSocketId = null } = {}) => {
        const removed = await Identity.findOneAndDelete({ userId, ...onlyIf }).lean()
        if (!removed) return false
        devices.revokeLoginsUnderWay(userId)
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
        presence.tell([...presence.users.values()].filter(seesDirectory).map(user => user.userId), event, payload)
    }

    // Completes a login on a socket that has just been attached: everything the client
    // needs to draw itself, in one event. If that cannot be gathered the login is undone,
    // so the client is never left logged in with half a picture.
    //
    // `onConfirmed`, if given, is called once the client has acknowledged the event — or
    // with an error if it has not within the time allowed.
    const sendLoggedIn = async (socket, user, sessionToken, extra = {}, { undoOnFailure = true, onConfirmed = null } = {}) => {
        let conversations, members, groupIds
        try {
            ;[conversations, members, groupIds] = await Promise.all([
                conversationsFor(user.userId), seesDirectory(user) ? directory() : undefined, groupIdsOf(user.userId),
            ])
        } catch (error) {
            if (undoOnFailure) presence.detach(socket.id)
            throw error
        }
        if (!socket.connected) return false
        const emitter = onConfirmed === null ? socket : socket.timeout(settings.reservationAckTimeoutMs)
        emitter.emit('loggedin', {
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
            // Every group they are in: a client that was away while they were taken out of
            // one finds out by its absence here.
            groupIds,
            ...(members === undefined ? {} : { members }),
            ...extra,
        }, ...(onConfirmed === null ? [] : [onConfirmed]))
        // Not part of logging in, and not allowed to fail it.
        onConversationsListed(user.userId, conversations)
            .catch(error => console.error("failed to record what a login delivered:", error.name))
        return true
    }

    // ---------- login

    const loginAsGuest = async (socket, username, payload) => {
        // The bot's name is reserved even where the bot is switched off: otherwise
        // someone could pose as it, or read the conversations people had with it.
        if (isBotName(username)) refuse(IN_USE)
        if (!settings.guests) refuse('Guest access is off — sign in with an account')
        if (isAdminName(username)) refuse(RESERVED)
        requireDatabase()
        await indexesReady()

        let identity = await Identity.findOne({ usernameKey: usernameKeyOf(username) }).lean()
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
        } else if (!holdsReservation(payload, identity)) {
            refuse(IN_USE)
        } else {
            await Identity.updateOne({ userId: identity.userId }, { lastSeenAt: new Date() })
        }
        // A name reserved a moment ago whose secret never reaches the browser is a name
        // nobody can ever use — its own owner included, until it lapses. So if this login
        // does not get as far as delivering the secret, the reservation is undone.
        const undoReservation = async () => {
            if (reservation === null) return
            // If the connection is somehow still there, it is told and closed: it must not
            // carry on as a user who is about to stop existing.
            const attached = presence.bySocket.get(socket.id)
            if (attached?.userId === identity.userId) presence.revoke(attached, { reason: 'The login could not be completed — try again' })
            // Announced for a moment, they may already have been written to or put in a
            // group: they go the way anyone who stops existing goes.
            await removeIdentity(identity.userId, {
                reason: 'The login could not be completed — try again',
                onlyIf: { kind: 'guest', secretHash: identity.secretHash },
            }).catch(error => console.error("failed to undo a reservation:", error?.name))
        }
        if (!socket.connected) {
            await undoReservation()
            return
        }

        // A guest holds one connection: coming back on a new one takes over from the old.
        const online = presence.users.get(identity.userId)
        const replaceSocketId = online ? online.sockets.keys().next().value ?? null : null
        const { user, sessionToken } = presence.attach(socket, identity, { replaceSocketId })
        if (reservation === null) {
            await sendLoggedIn(socket, user, sessionToken)
            return
        }

        // A new name: the browser has to say it received the secret. Sending it is not
        // enough — a connection can die with the packet on its way, and the server would
        // be none the wiser. Until the browser confirms, the reservation is provisional:
        // if the connection closes first, or no confirmation comes in time, it is undone.
        let settled = false
        const giveUp = async () => {
            if (settled) return
            settled = true
            await undoReservation()
        }
        socket.once('disconnect', giveUp)
        let delivered = false
        try {
            delivered = await sendLoggedIn(socket, user, sessionToken, { reservation }, {
                onConfirmed: error => {
                    if (error) {
                        giveUp()
                        return
                    }
                    settled = true
                    socket.off('disconnect', giveUp)
                },
            })
        } finally {
            // (Waited for: the client is told to try again only once the name is free again.)
            if (!delivered) await giveUp()
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

        const created = deviceSession === null ? await devices.create(identity.userId, payload.deviceLabel) : null
        const deviceSessionId = created?.deviceSessionId ?? deviceSession._id.toString()
        await Identity.updateOne({ userId: identity.userId }, { lastSeenAt: new Date() })

        // From here to `attach` nothing waits, so what is checked now still holds then.
        // A session created above that will not be handed over is removed again: nobody
        // received its token, so nobody could ever use it, and it would only sit in the
        // account's list of devices.
        const abandon = async () => {
            if (created) await Session.deleteOne({ _id: deviceSessionId })
        }
        if (devices.wasRevokedSince(startedAt, identity.userId, deviceSessionId)) {
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
        let delivered = false
        try {
            delivered = await sendLoggedIn(socket, user, sessionToken, created ? { session: created.token } : {})
        } finally {
            // The new session's token never reached the device: it is not a device.
            if (!delivered) await abandon().catch(() => {})
        }
    }

    const loginWithPassword = async (socket, username, payload, startedAt) => {
        if (typeof payload.password !== 'string' || payload.password.length > MAX_PASSWORD_LENGTH) refuse(WRONG_PASSWORD)
        requireDatabase()
        const identity = await accountIfRight(socket, username, payload.password, 'passwordHash')
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
        const username = usernameIn(payload)

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
        const username = usernameIn(payload)
        if (!USERNAME_PATTERN.test(username)) refuse('Invalid username')
        if (!isPassword(payload.password)) refuse(PASSWORD_RULE)
        if (isBotName(username)) refuse(IN_USE)
        // A signed-in guest may turn their own name into an account; nothing else may
        // register from a socket that is already somebody.
        const isOwnGuestName = user?.kind === 'guest' && usernameKeyOf(user.username) === usernameKeyOf(username)
        if (user && !isOwnGuestName) refuse('Already logged in')
        if (settings.signupMode === 'closed') refuse('Sign-up is closed')

        // Administrator names can be registered in one way only: with the bootstrap code.
        const asAdmin = isAdminName(username)
        if (asAdmin) {
            // No code configured, or none offered: reserved, and nothing was guessed.
            if (settings.bootstrapCode === null || !isSecret(payload.bootstrapCode)) refuse(RESERVED)
            // A code offered is a guess at a secret, and is limited like a guess at a
            // password: a few tries for this name from this address, then a growing wait.
            const right = await checkGuess(socket, username, async () => sameString(payload.bootstrapCode, settings.bootstrapCode))
            if (!right) refuse(RESERVED)
        }
        const needsInvitation = settings.signupMode === 'invite' && !asAdmin
        if (needsInvitation && !isSecret(payload.invitation)) refuse('An invitation is needed to sign up')

        if (!allowedForAddress(socket, 'registrationsPerAddress')) {
            refuse('Too many sign-ups from this network, try again later')
        }
        await indexesReady()

        const existing = await Identity.findOne({ usernameKey: usernameKeyOf(username) }).lean()
        const upgrading = existing?.kind === 'guest' && !asAdmin && (
            (isOwnGuestName && user.userId === existing.userId) ||
            holdsReservation(payload, existing)
        )
        if (existing && !upgrading) refuse(IN_USE)

        const invitationFilter = () => ({ codeHash: fingerprint(payload.invitation), expiresAt: { $gt: new Date() } })
        const INVALID_INVITATION = 'That invitation is not valid any more'
        // Checked before the (slow) hashing, consumed after it.
        if (needsInvitation && !await Invitation.exists(invitationFilter())) refuse(INVALID_INVITATION)

        const { recoveryCode, passwordHash, recoveryHash } = await newCredentials(payload.password)

        // Deleting the invitation is what makes it single-use: only one request gets it back.
        const invitation = needsInvitation ? await Invitation.findOneAndDelete(invitationFilter()).lean() : null
        if (needsInvitation && !invitation) refuse(INVALID_INVITATION)

        // The device session is stored first, the account second. If the second fails the
        // first is taken back; if the first fails nothing exists yet. There is no order of
        // failures that leaves an account whose recovery code nobody was ever shown.
        const userId = upgrading ? existing.userId : randomUUID()
        const { token, deviceSessionId } = await devices.create(userId, payload.deviceLabel)
        const takeBack = async () => {
            await Session.deleteOne({ _id: deviceSessionId }).catch(() => {})
            if (invitation) await Invitation.create(invitation).catch(() => {})
        }

        let identity
        try {
            identity = upgrading
                ? await Identity.findOneAndUpdate(
                    { userId, kind: 'guest' },
                    { $set: { kind: 'account', passwordHash, recoveryHash, lastSeenAt: new Date() }, $unset: { secretHash: 1 } },
                    { returnDocument: 'after' },
                ).lean()
                : (await Identity.create({
                    userId, username, kind: 'account', admin: asAdmin, passwordHash, recoveryHash,
                })).toObject()
        } catch (error) {
            await takeBack()
            if (!isDuplicateKey(error)) throw error
            // The name went to someone else in the meantime.
            refuse(IN_USE)
        }
        if (!identity) {
            // (An upgrade whose guest was gone by now.) The invitation was not used.
            await takeBack()
            refuse(IN_USE)
        }

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
            // As an account they are now shown every other account, where that is on — and
            // must be told now, not at their next login.
            if (directoryOn && online.sockets.size > 0) {
                presence.tell([online.userId], 'memberDirectory', { members: await directory() })
            }
        }
        tellDirectory('memberJoined', { userId: identity.userId, username: identity.username, kind: 'account' })
        return { session: token, recoveryCode, kind: 'account', admin: identity.admin === true }
    }

    const resetPassword = async ({ socket, payload }) => {
        const username = usernameIn(payload)
        if (!USERNAME_PATTERN.test(username) || typeof payload.recoveryCode !== 'string' || payload.recoveryCode.length > 100) {
            refuse(WRONG_RECOVERY)
        }
        if (!isPassword(payload.newPassword)) refuse(PASSWORD_RULE)
        const identity = await accountIfRight(socket, username, normaliseRecoveryCode(payload.recoveryCode), 'recoveryHash')
        if (!identity) refuse(WRONG_RECOVERY)

        // A recovery code works once: a new one replaces it.
        const { recoveryCode, passwordHash, recoveryHash } = await newCredentials(payload.newPassword)
        await Identity.updateOne({ userId: identity.userId }, { passwordHash, recoveryHash })
        await devices.end(identity.userId, {}, { reason: 'The password was reset', loginsUnderWay: true })
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
        // Every other device is signed out; this one carries on. And a sign-in with the old
        // password that is still being completed must not finish after this.
        await devices.end(
            user.userId,
            { _id: { $ne: entry.deviceSessionId } },
            { reason: 'The password was changed', exceptSocketId: socket.id, loginsUnderWay: true },
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
        const ended = await devices.end(user.userId, { _id: payload.id }, { reason: 'Signed out from another device' })
        if (ended === 0) refuse('Unknown device')
        return {}
    }

    // This device only. The connection stays open, logged out, so the page can show the
    // entry screen without reconnecting; other tabs sharing the device session are closed.
    const logout = async ({ socket, user, entry }) => {
        if (user.kind === 'account' && entry.deviceSessionId !== null && isDatabaseReady()) {
            await devices.end(user.userId, { _id: entry.deviceSessionId }, { exceptSocketId: socket.id })
        }
        presence.detach(socket.id)
        return {}
    }

    const deleteAccount = async ({ socket, user, payload }) => {
        await confirmPassword(socket, user, payload.password)
        await removeIdentity(user.userId, { reason: 'The account was deleted', keepSocketId: socket.id })
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
                const { payload, reply, fail } = withAck(rawPayload, rawAck)

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
        pruneGuesses()
        // The per-address allowances are counted over an hour; older records say nothing.
        rateLimiter.prune(HOUR)
        devices.prune(now, HOUR)
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
