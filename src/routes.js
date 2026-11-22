import express, { Router } from 'express'
import createError from 'http-errors'
import { clientAddress } from './clientAddress.js'
import { isDatabaseReady } from './db.js'

/** The socket protocol's version. A client built for another one should say so, not misbehave. */
export const PROTOCOL_VERSION = 2

export const createRouter = ({ getOnlineUsers, settings, leaveCall = () => {} }) => {
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

    // For setting up a new host, and switched off otherwise. A host's proxies are not
    // always documented, and TRUSTED_PROXY_HOPS has to match them exactly: too low and
    // every visitor shares one address, too high and a visitor can forge theirs. This
    // shows the asker how their own request arrived, and which address each setting
    // would take them for — compare it with their real public address. It reveals
    // nothing about anyone else.
    if (settings.proxyCheck) {
        router.get('/proxy-check', (req, res) => {
            const seen = { remoteAddress: req.socket.remoteAddress, forwardedFor: req.headers['x-forwarded-for'] }
            const chain = String(seen.forwardedFor ?? '').split(',').map(entry => entry.trim()).filter(Boolean)
            res.send({
                connectionFrom: clientAddress(seen, 0),
                forwardedFor: chain,
                addressWithHops: Object.fromEntries([0, 1, 2, 3, 4].map(hops => [hops, clientAddress(seen, hops)])),
                configuredHops: settings.trustedProxyHops,
                addressAsConfigured: clientAddress(seen, settings.trustedProxyHops),
            })
        })
    }

    // A page that is being closed hangs up its call here: a browser delivers a beacon
    // sent while unloading, and promises nothing of the kind for a socket. The body is
    // `{ callId, secret }` as text (which needs no permission asked first); the secret
    // is what makes it the device's own. Always the same answer, whatever was sent.
    router.post('/call/leave', express.text({ type: () => true, limit: 500 }), (req, res) => {
        try {
            const { callId, secret } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
            const address = clientAddress({ remoteAddress: req.socket.remoteAddress, forwardedFor: req.headers['x-forwarded-for'] }, settings.trustedProxyHops)
            leaveCall({ callId, secret, address })
        } catch {
            // Not something this route understands: nothing to do, and nothing to say.
        }
        res.status(204).end()
    })

    // For hosting platforms and uptime checks. Always 200 while the process is alive:
    // the server is designed to stay up without its database, and to say so.
    router.get('/health', (req, res) => {
        res.send({ status: 'ok', db: isDatabaseReady() ? 'up' : 'down' })
    })

    return router
}
