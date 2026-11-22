import { createRateLimiter } from '../rateLimit.js'
import { createIceServers } from '../turn.js'
import { createCallHandlers } from './calls.js'
import { MAX_ATTACHMENTS_PER_MESSAGE, createAttachments, createFileHandlers } from './files.js'
import { createGroupHandlers } from './groups.js'
import { createMessageHandlers } from './messages.js'
import { createPresence } from './presence.js'
import { createSessionHandlers } from './session.js'
import { createStatusHandlers } from './status.js'

// Wires every socket event onto `io`. All state is created here, per call, so each app
// instance has its own. The events themselves live beside this file, by concern:
// session.js (who somebody is), messages.js (conversations and what is said in them),
// groups.js (making a group and changing who is in it), files.js (attachments),
// calls.js (ringing someone, and what two browsers say to set a call up),
// status.js (what a user chooses to show), presence.js (who is connected, and who can see it). Returns read access to the public view of who is
// online, and the hourly housekeeping routine.
export const registerSocketHandlers = (io, settings, { storage = null } = {}) => {
    const presence = createPresence(io, { demoBot: settings.demoBot })
    const rateLimiter = createRateLimiter()
    const attachments = createAttachments({ storage, settings })
    const messages = createMessageHandlers({ io, presence, settings, rateLimiter, attachments })
    const files = createFileHandlers({ presence, settings, rateLimiter, attachments, messages })
    const groups = createGroupHandlers({
        presence, settings, rateLimiter, messages, onConversationDeleted: attachments.conversationDeleted,
    })
    const calls = createCallHandlers({
        presence, settings, rateLimiter, messages,
        // Relay credentials are made to outlast the longest call there can be.
        iceServers: createIceServers({ turn: settings.turn, ttlSeconds: (settings.callMaxMs + settings.callRingTimeoutMs) / 1000 + 600 }),
    })
    // A socket that stops being logged in — closed, logged out, replaced — leaves its call.
    presence.hooks.detached = calls.socketGone
    const status = createStatusHandlers({ presence, rateLimiter, onVisibleAgain: messages.visibleAgain })
    const session = createSessionHandlers({
        presence, settings, rateLimiter,
        // What this deployment offers, for a client to show or hide.
        features: {
            files: attachments.enabled,
            calls: true,
            ...(attachments.enabled ? { maxFileBytes: attachments.limits.fileBytes, maxFilesPerMessage: MAX_ATTACHMENTS_PER_MESSAGE } : {}),
        },
        onIdentityRemoved: async userId => {
            await messages.identityRemoved(userId)
            await groups.identityRemoved(userId)
        },
        onConversationsListed: messages.listDelivered,
        onLoggedIn: calls.socketJoined,
    })

    io.on('connection', socket => {
        console.log("socket connected:", socket.id)

        session.registerOn(socket)
        messages.registerOn(socket)
        groups.registerOn(socket)
        files.registerOn(socket)
        calls.registerOn(socket)
        status.registerOn(socket)

        socket.on('disconnect', () => {
            console.log("socket disconnected:", socket.id)
            rateLimiter.forget(socket.id)
            // (Also for a socket its user's newer connection has already replaced.)
            calls.socketGone(socket.id)
            // Says nothing for a socket that never logged in, or one already replaced by
            // its user's newer connection.
            presence.detach(socket.id)
        })
    })

    return {
        getOnlineUsers: presence.getOnlineUsers,
        runMaintenance: session.runMaintenance,
        // Files have housekeeping of their own: every five minutes, uploads that were
        // reserved and never sent; every hour, files whose message has expired.
        sweepPendingUploads: attachments.sweepPending,
        sweepExpiredFiles: attachments.sweepExpired,
        hasherStats: session.hasherStats,
        leaveCall: calls.leave,
    }
}
