import express from "express"
import cors from 'cors'
import createError from 'http-errors'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { registerSocketHandlers } from './sockets/index.js'
import { createRouter } from './routes.js'
import { resolveSettings } from './settings.js'

// Returns the origin part of a URL ("http://localhost:5173"), or null if it is not one.
const toOrigin = value => {
    try {
        const { origin } = new URL(value)
        return origin === 'null' ? null : origin
    } catch {
        return null
    }
}

// Builds the Express app, HTTP server and Socket.IO server, fully wired, without
// listening or connecting to the database — the caller decides when to do both.
// `options` are the deployment settings (see settings.js); every one has a default.
export const createApp = (options = {}) => {
    const settings = resolveSettings(options)

    // Browser origins allowed to talk to this server, from a comma-separated FRONTEND_URL.
    const configured = (process.env.FRONTEND_URL || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)
    // Browsers send an origin as scheme://host[:port], lower-case and with no trailing
    // slash; normalise each entry to that form so "http://localhost:5173/" still matches.
    const allowedOrigins = configured.map(toOrigin).filter(Boolean)

    if (allowedOrigins.length < configured.length) {
        console.warn(` ⚠️  FRONTEND_URL: ignored ${configured.length - allowedOrigins.length} entr${configured.length - allowedOrigins.length === 1 ? 'y that is' : 'ies that are'} not a valid URL`)
    }
    if (allowedOrigins.length === 0) {
        console.warn(" ⚠️  FRONTEND_URL is not set: no browser origin is allowed to connect")
    }

    const app = express()

    // So that Express and the socket handlers agree on a client's address (clientAddress.js).
    if (settings.trustedProxyHops > 0) app.set('trust proxy', settings.trustedProxyHops)

    app.use(cors({ origin: allowedOrigins }))
    app.use(express.json())

    const server = createServer(app)

    const io = new Server(server, {
        // The largest legitimate payload is a 2000-character message; the default is 1 MB.
        maxHttpBufferSize: 10_000,
        // Covers the long-polling transport.
        cors: { origin: allowedOrigins },
        // Covers the WebSocket handshake, which CORS does not apply to.
        // Requests without an Origin header (non-browser clients) are allowed.
        allowRequest: (req, callback) => {
            const origin = req.headers.origin
            callback(null, !origin || allowedOrigins.includes(origin))
        },
    })

    const { getOnlineUsers, runMaintenance, hasherStats } = registerSocketHandlers(io, settings)

    // Hourly housekeeping (idle guests, last-seen times). It never keeps the process
    // alive by itself, and stops with the server.
    const housekeeping = setInterval(() => {
        runMaintenance().catch(error => console.error("housekeeping failed:", error.name))
    }, 60 * 60_000)
    housekeeping.unref()
    server.on('close', () => clearInterval(housekeeping))

    app.use(createRouter({ getOnlineUsers, settings }))

    app.use((req, res, next) => next(createError(404)))

    // Express identifies an error handler by its four parameters: keep all of them,
    // including the unused last one.
    app.use((err, req, res, _next) => {
        const status = err.status || 500
        if (status >= 500) {
            console.error(err)
            res.status(status).json({ message: 'Internal server error' })
            return
        }
        res.status(status).json({ message: err.message })
    })

    return { app, server, io, runMaintenance, hasherStats }
}
