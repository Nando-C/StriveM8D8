import express from "express"
import cors from 'cors'
import createError from 'http-errors'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { registerSocketHandlers } from './sockets/index.js'
import { createRouter } from './routes.js'

// Builds the Express app, HTTP server and Socket.IO server, fully wired, without
// listening or connecting to the database — the caller decides when to do both.
export const createApp = () => {
    // Browser origins allowed to talk to this server, from a comma-separated FRONTEND_URL.
    const allowedOrigins = (process.env.FRONTEND_URL || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)

    if (allowedOrigins.length === 0) {
        console.warn(" ⚠️  FRONTEND_URL is not set: no browser origin is allowed to connect")
    }

    const app = express()

    app.use(cors({ origin: allowedOrigins }))
    app.use(express.json())

    const server = createServer(app)

    const io = new Server(server, {
        // Covers the long-polling transport.
        cors: { origin: allowedOrigins },
        // Covers the WebSocket handshake, which CORS does not apply to.
        // Requests without an Origin header (non-browser clients) are allowed.
        allowRequest: (req, callback) => {
            const origin = req.headers.origin
            callback(null, !origin || allowedOrigins.includes(origin))
        },
    })

    const { getOnlineUsers } = registerSocketHandlers(io)

    app.use(createRouter({ getOnlineUsers }))

    app.use((req, res, next) => next(createError(404)))

    // Express identifies an error handler by its four parameters: keep all of them.
    app.use((err, req, res, next) => {
        const status = err.status || 500
        if (status >= 500) {
            console.error(err)
            res.status(status).json({ message: 'Internal server error' })
            return
        }
        res.status(status).json({ message: err.message })
    })

    return { app, server, io }
}
