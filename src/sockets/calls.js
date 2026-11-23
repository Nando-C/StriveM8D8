import { randomUUID } from 'node:crypto'
import { newSecret, sameString } from '../auth/secrets.js'
import { BOT, BOT_REPLY_DELAY_MS } from '../bot.js'
import { directConversationId, isUserId } from '../conversations.js'
import { isDatabaseReady } from '../db.js'
import { COULD_NOT_BE_SAVED, answering, isNonEmptyString, isObject, refuse } from './validation.js'

// Calls between two people. The sound and pictures never pass through this server: the
// two browsers connect to each other (WebRTC). What goes through here is the signalling
// — who is calling whom, whether it was answered, and the descriptions and candidates
// the two browsers exchange to find a path between them — and, when a call is over, a
// line in the conversation saying that it happened.
//
// A call is `ringing` until the person called accepts on one of their devices, then
// `active`. It belongs to two *devices*, not to two socket ids: each is given a secret
// for the call, and after a dropped connection a new socket that presents it takes the
// call back. Everything is kept in memory: a call does not survive the server.

const CALL_MEDIA = ['audio', 'video']
// Why a call is over, as both sides are told (`call:ended`) and as the conversation
// records it: 'ended', 'declined', 'cancelled', 'missed', 'busy', 'dnd', 'unavailable' or 'failed'.

/**
 * The longest session description that is passed on. Chromium's offers measure 1.3 kB
 * (sound), 5.4 kB (with a camera) and 10.5–14 kB (with a shared screen as well, all
 * candidates included); other browsers are wordier. `maxHttpBufferSize` in app.js must
 * stay above this.
 */
export const MAX_SDP_LENGTH = 48_000
const MAX_CANDIDATE_LENGTH = 1000
const MAX_MID_LENGTH = 64
const MAX_FRAGMENT_LENGTH = 256
const DESCRIPTION_TYPES = ['offer', 'answer', 'pranswer', 'rollback']
const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SECRET_LENGTH = 43

// Per socket.
const RATE_LIMITS = {
    // Each one rings somebody, or leaves a line in a conversation.
    invite: { limit: 6, windowMs: 60_000 },
    answer: { limit: 20, windowMs: 10_000 },
    // Each one may ask the relay provider for credentials.
    config: { limit: 5, windowMs: 10_000 },
    // Candidates arrive in bursts: a dozen or two per description, from each side.
    signal: { limit: 200, windowMs: 10_000 },
}
// Per client address: hanging up over HTTP, which no socket's limit covers.
const LEAVE_LIMIT = { limit: 30, windowMs: 60_000 }

const INVALID_CALL = 'Invalid call'
// One answer for a call that does not exist, is somebody else's, or is not this device's.
const UNKNOWN_CALL = 'Unknown call'
const INVALID_SIGNAL = 'Invalid signal'
const WHY_NOT = {
    unavailable: 'They cannot be reached right now',
    dnd: 'They have asked not to be disturbed',
    busy: 'They are in another call',
}

// (A side that no device holds has no secret, and nothing matches it.)
const sameSecret = (given, held) => typeof given === 'string' && given.length === SECRET_LENGTH && sameString(given, held)

// A session description as it is passed on: its two fields, and nothing else a client put there.
const descriptionIn = value => {
    if (!isObject(value) || !DESCRIPTION_TYPES.includes(value.type)) return null
    if (value.type === 'rollback') return value.sdp === undefined || value.sdp === '' ? { type: 'rollback', sdp: '' } : null
    return isNonEmptyString(value.sdp, MAX_SDP_LENGTH) ? { type: value.type, sdp: value.sdp } : null
}

// A candidate likewise. (An empty one says there are no more.)
const candidateIn = value => {
    if (!isObject(value)) return null
    const { candidate, sdpMid = null, sdpMLineIndex = null, usernameFragment = null } = value
    const short = (text, max) => text === null || (typeof text === 'string' && text.length <= max)
    if (typeof candidate !== 'string' || candidate.length > MAX_CANDIDATE_LENGTH) return null
    if (!short(sdpMid, MAX_MID_LENGTH) || !short(usernameFragment, MAX_FRAGMENT_LENGTH)) return null
    if (sdpMLineIndex !== null && !(Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex <= 255)) return null
    return { candidate, sdpMid, sdpMLineIndex, usernameFragment }
}

/**
 * The socket events of calls, and the calls themselves. `messages` writes the line a
 * call leaves in its conversation; `iceServers()` resolves to the servers the two
 * browsers are to use.
 */
export const createCallHandlers = ({ presence, settings, rateLimiter, messages, iceServers }) => {
    const allowed = rateLimiter.perSocket(RATE_LIMITS)
    /** callId → call */
    const calls = new Map()
    /** userId → the one call they are in, ringing or active */
    const byUser = new Map()

    // One side of a call: who, and — once they are in it — which device. `socketId` is
    // null while that device's connection is down; `lost` is then the timer that ends
    // the call if it does not come back.
    const side = (person, socketId = null) => ({
        userId: person.userId, username: person.username,
        secret: socketId === null ? null : newSecret(), socketId, lost: null,
    })
    const sideOf = (call, userId) =>
        call.caller.userId === userId ? call.caller : call.callee.userId === userId ? call.callee : null
    const otherSide = (call, own) => (own === call.caller ? call.callee : call.caller)
    const later = (ms, action) => setTimeout(action, ms).unref()

    // What a call leaves behind: a line in the conversation, written as the caller's.
    // The client words `outcome` for whoever reads it.
    const record = ({ conversationId, caller, media }, outcome, durationMs = 0) =>
        messages.say(conversationId, { userId: caller.userId, username: caller.username }, { kind: 'call', data: { media, outcome, durationMs } })
            .catch(error => console.error("failed to record a call:", error?.name))

    /** Ends a call, tells both sides why, and records it — once, however many things end it at once. */
    const finish = (call, reason) => {
        if (calls.get(call.callId) !== call) return
        calls.delete(call.callId)
        for (const { userId, lost } of [call.caller, call.callee]) {
            if (byUser.get(userId) === call) byUser.delete(userId)
            clearTimeout(lost)
        }
        for (const timer of Object.values(call.timers)) clearTimeout(timer)
        // (Whoever is still being rung stops ringing, too.)
        presence.tellSockets([call.caller.socketId, call.callee.socketId, ...call.ringing], 'call:ended', { callId: call.callId, reason })
        record(call, reason, call.startedAt === null ? 0 : Date.now() - call.startedAt)
    }

    // One side hangs up: a call that was still ringing was cancelled, whatever ended it.
    const hangUp = (call, active = 'ended') => finish(call, call.state === 'ringing' ? 'cancelled' : active)

    // Tells the device on one side of a call, if a device is there. (`tellSockets`
    // passes over an id that is not a connected socket's, `null` included.)
    const tellSide = (call, own, event, more) => presence.tellSockets([own.socketId], event, { callId: call.callId, ...more })

    const callNamed = callId => (typeof callId === 'string' && CALL_ID.test(callId) ? calls.get(callId) : undefined)

    const begin = ({ caller, socket, to, media, conversationId }) => {
        const call = {
            callId: randomUUID(), conversationId, media, state: 'ringing', startedAt: null,
            caller: side(caller, socket.id), callee: side({ userId: to, username: null }),
            /** The sockets of the person called that are ringing. */
            ringing: new Set(),
            timers: {},
        }
        calls.set(call.callId, call)
        byUser.set(caller.userId, call)
        byUser.set(to, call)
        return call
    }

    const invite = async ({ socket, user, payload }) => {
        const { to, media } = payload
        if (!isUserId(to) || to === user.userId || !CALL_MEDIA.includes(media)) refuse(INVALID_CALL)
        // (A call begins by looking the two people up, and ends by writing a line.)
        if (!isDatabaseReady()) refuse(COULD_NOT_BE_SAVED)
        // Whoever may write to someone may call them: the same rule, asked of the same place.
        const conversationId = directConversationId(user.userId, to)
        const refusal = await messages.refusalToWrite(conversationId, user)
        if (refusal) refuse(refusal)
        // (Nothing is awaited from here on: two invitations cannot both find the line free.)
        if (byUser.has(user.userId)) refuse('You are already in a call', { reason: 'in-call' })

        // The bot has nothing to answer with: it rings for a moment, and declines.
        const toBot = to === BOT.id
        const callee = presence.users.get(to)
        // Someone invisible is, to the caller, someone who is not connected: the same
        // answer, by the same path, with nothing awaited that would tell the two apart.
        const whyNot =
            toBot ? null
            : callee === undefined || presence.publicUser(callee) === null ? 'unavailable'
            : callee.status === 'dnd' ? 'dnd'
            : byUser.has(to) ? 'busy'
            : null
        if (whyNot !== null) {
            // They find a missed call in the conversation. (After the caller is answered.)
            setImmediate(() => record({ conversationId, caller: user, media }, whyNot))
            refuse(WHY_NOT[whyNot], { reason: whyNot })
        }

        const call = begin({ caller: user, socket, to, media, conversationId })
        if (toBot) call.timers.bot = later(BOT_REPLY_DELAY_MS, () => finish(call, 'declined'))
        else {
            for (const socketId of presence.socketsOf(to)) call.ringing.add(socketId)
            call.timers.ring = later(settings.callRingTimeoutMs, () => finish(call, 'missed'))
            presence.tellSockets([...call.ringing], 'call:incoming', incomingOf(call))
        }
        return { callId: call.callId, secret: call.caller.secret }
    }

    const incomingOf = call => ({
        callId: call.callId, conversationId: call.conversationId, media: call.media,
        from: { userId: call.caller.userId, username: call.caller.username },
    })

    /** The call a payload names, and the asker's side of it — or a refusal that says nothing more. */
    const callOf = (payload, user) => {
        const call = callNamed(payload.callId)
        const own = call === undefined ? null : sideOf(call, user.userId)
        if (own === null) refuse(UNKNOWN_CALL)
        return { call, own }
    }
    /** The same, for something only the device that is in the call may do. */
    const deviceOf = (payload, user, socket) => {
        const found = callOf(payload, user)
        if (found.own.socketId !== socket.id) refuse(UNKNOWN_CALL)
        return found
    }

    // The first device to accept takes the call; the others stop ringing.
    const accept = async ({ socket, user, payload }) => {
        const { call, own } = callOf(payload, user)
        if (own !== call.callee) refuse(UNKNOWN_CALL)
        if (call.state !== 'ringing') refuse('Answered on another device', { reason: 'answered-elsewhere' })
        call.state = 'active'
        call.startedAt = Date.now()
        clearTimeout(call.timers.ring)
        own.socketId = socket.id
        own.secret = newSecret()
        const others = [...call.ringing].filter(socketId => socketId !== socket.id)
        call.ringing.clear()
        presence.tellSockets(others, 'call:ended', { callId: call.callId, reason: 'answered-elsewhere' })
        tellSide(call, call.caller, 'call:accepted')
        call.timers.cap = later(settings.callMaxMs, () => finish(call, 'ended'))
        return { secret: own.secret }
    }

    const decline = async ({ user, payload }) => {
        const { call, own } = callOf(payload, user)
        if (own !== call.callee || call.state !== 'ringing') refuse(UNKNOWN_CALL)
        finish(call, 'declined')
        return {}
    }

    const cancel = async ({ socket, user, payload }) => {
        const { call, own } = deviceOf(payload, user, socket)
        if (own !== call.caller || call.state !== 'ringing') refuse(UNKNOWN_CALL)
        finish(call, 'cancelled')
        return {}
    }

    // Hanging up, whatever state the call is in: what a page sends as it closes.
    const end = async ({ socket, user, payload }) => {
        const { call, own } = callOf(payload, user)
        if (call.state === 'ringing' && own === call.callee) finish(call, 'declined')
        else if (own.socketId !== socket.id) refuse(UNKNOWN_CALL)
        else hangUp(call)
        return {}
    }

    // What the two browsers say to each other, passed to the other device and to nobody else.
    const signal = async ({ socket, user, payload }) => {
        const { call, own } = deviceOf(payload, user, socket)
        const hasDescription = payload.description !== undefined
        if (hasDescription === (payload.candidate !== undefined)) refuse(INVALID_SIGNAL)
        const content = hasDescription ? descriptionIn(payload.description) : candidateIn(payload.candidate)
        if (content === null) refuse(INVALID_SIGNAL)
        if (call.state !== 'active') refuse('The call has not been answered')
        const peer = otherSide(call, own)
        if (peer.socketId === null) refuse('The other side is not connected right now', { reason: 'peer-lost' })
        tellSide(call, peer, 'call:signal', { [hasDescription ? 'description' : 'candidate']: content })
        return {}
    }

    // A device comes back after losing its connection. Knowing the call's id is not
    // enough — the user's other devices know it too: it takes the secret.
    const rejoin = async ({ socket, user, payload }) => {
        const { call, own } = callOf(payload, user)
        if (!sameSecret(payload.secret, own.secret)) refuse(UNKNOWN_CALL)
        clearTimeout(own.lost)
        own.lost = null
        own.socketId = socket.id
        const peer = otherSide(call, own)
        tellSide(call, peer, 'call:peer', { connected: true })
        return { state: call.state, media: call.media, peerConnected: peer.socketId !== null }
    }

    // Relay credentials cost their provider money: only for a device that is in a call.
    const config = async ({ socket, user, payload }) => {
        deviceOf(payload, user, socket)
        return { iceServers: await iceServers() }
    }

    /**
     * A socket's connection is gone without it having hung up. If it was a device in a
     * call, the call waits a while for it to come back; if it was only ringing, it rings
     * no more there. A call that was still ringing when the wait runs out was never
     * answered because its caller went: to the person called that is a call they missed.
     */
    const socketGone = socketId => {
        for (const call of calls.values()) {
            call.ringing.delete(socketId)
            for (const own of [call.caller, call.callee]) {
                if (own.socketId !== socketId) continue
                own.socketId = null
                own.lost = later(settings.callGraceMs, () => hangUp(call, 'failed'))
                tellSide(call, otherSide(call, own), 'call:peer', { connected: false })
            }
        }
    }

    /**
     * A socket stopped being its user on purpose — signed out, or was signed out (from
     * another device, by a changed password, by the account going). That device is not
     * coming back to its call: the call ends now, not after a wait.
     */
    const socketLeft = socketId => {
        // (Deleting from a Map while iterating over it is safe.)
        for (const call of calls.values()) {
            call.ringing.delete(socketId)
            if (call.caller.socketId === socketId || call.callee.socketId === socketId) hangUp(call)
        }
    }

    /**
     * Hanging up without a socket: what a page sends as it is closed or reloaded, when
     * the browser no longer promises that anything said over the socket gets out
     * (`navigator.sendBeacon`). Whoever holds a device's secret for the call is that
     * device. Says nothing back — not even whether there was such a call.
     */
    const leave = ({ callId, secret, address }) => {
        if (!rateLimiter.allow(`address:${address}`, 'call:leave', LEAVE_LIMIT)) return
        const call = callNamed(callId)
        if (call !== undefined && [call.caller, call.callee].some(own => sameSecret(secret, own.secret))) hangUp(call)
    }

    /** A device has just logged in: if its user is being called, it rings too. */
    const socketJoined = (socket, user) => {
        const call = byUser.get(user.userId)
        if (call === undefined || call.state !== 'ringing' || call.callee.userId !== user.userId) return
        call.ringing.add(socket.id)
        presence.tellSockets([socket.id], 'call:incoming', incomingOf(call))
    }

    // (A call under way does not stop because the database is out of reach for a moment.)
    const answer = answering({ presence, allowed, database: false })

    const registerOn = socket => {
        const on = answer(socket)
        on('call:invite', 'invite', invite)
        on('call:accept', 'answer', accept)
        on('call:decline', 'answer', decline)
        on('call:cancel', 'answer', cancel)
        on('call:end', 'answer', end)
        on('call:rejoin', 'answer', rejoin)
        on('call:config', 'config', config)
        on('call:signal', 'signal', signal)
    }

    return { registerOn, socketGone, socketLeft, socketJoined, leave }
}
