import { createRateLimiter } from '../rateLimit.js'
import { MAX_ATTACHMENTS_PER_MESSAGE, createAttachments, createFileHandlers } from './files.js'
import { createGroupHandlers } from './groups.js'
import { createMessageHandlers } from './messages.js'
import { createPresence } from './presence.js'
import { createSessionHandlers } from './session.js'
import { createStatusHandlers } from './status.js'

// Wires every socket event onto `io`. All state is created here, per call, so each app
// instance has its own. The events themselves live beside this file, by concern:
// session.js (who somebody is), messages.js (conversations and what is said in them),
// groups.js (making a group and changing who is in it),
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
    const status = createStatusHandlers({ presence, rateLimiter, onVisibleAgain: messages.visibleAgain })
    const session = createSessionHandlers({
        presence, settings, rateLimiter,
        // What this deployment offers, for a client to show or hide.
        features: {
            files: attachments.enabled,
            ...(attachments.enabled ? { maxFileBytes: attachments.limits.fileBytes, maxFilesPerMessage: MAX_ATTACHMENTS_PER_MESSAGE } : {}),
        },
        onIdentityRemoved: async userId => {
            await messages.identityRemoved(userId)
            await groups.identityRemoved(userId)
        },
        onConversationsListed: messages.listDelivered,
    })

    io.on('connection', socket => {
        console.log("socket connected:", socket.id)

        session.registerOn(socket)
        messages.registerOn(socket)
        groups.registerOn(socket)
        files.registerOn(socket)
        status.registerOn(socket)

        socket.on('disconnect', () => {
            console.log("socket disconnected:", socket.id)
            rateLimiter.forget(socket.id)
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
    }
}
