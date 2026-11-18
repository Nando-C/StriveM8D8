import { Router } from 'express'
import createError from 'http-errors'
import { isDatabaseReady } from './db.js'

/** The socket protocol's version. A client built for another one should say so, not misbehave. */
export const PROTOCOL_VERSION = 1

export const createRouter = ({ getOnlineUsers, settings }) => {
    const router = Router()

    // Where guests are switched off the deployment is private, and this would publish
    // its members' names to anyone who has the address.
    router.get('/online-users', (req, res, next) => {
        if (!settings.guests) {
            next(createError(404))
            return
        }
        res.send({ onlineUsers: getOnlineUsers() })
    })

    // What the entry screen needs to know before anyone is logged in: which ways in
    // exist. Modes only — never names or codes.
    router.get('/config', (req, res) => {
        res.send({ signup: settings.signupMode, guests: settings.guests, protocol: PROTOCOL_VERSION })
    })

    // For hosting platforms and uptime checks. Always 200 while the process is alive:
    // the server is designed to stay up without its database, and to say so.
    router.get('/health', (req, res) => {
        res.send({ status: 'ok', db: isDatabaseReady() ? 'up' : 'down' })
    })

    return router
}
