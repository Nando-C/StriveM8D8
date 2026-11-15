import 'dotenv/config'
import express from "express"
import cors from 'cors'
import createError from 'http-errors'
import { createServer } from 'http'
import { Server } from 'socket.io'
import listEndpoints from "express-list-endpoints"

const MAX_NAME_LENGTH = 30
const MAX_TEXT_LENGTH = 2000

// Browser origins allowed to talk to this server, from a comma-separated FRONTEND_URL.
const allowedOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)

if (allowedOrigins.length === 0) {
    console.warn(" ⚠️  FRONTEND_URL is not set: no browser origin is allowed to connect")
}

const isObject = value => typeof value === 'object' && value !== null
const isNonEmptyString = (value, maxLength) =>
    typeof value === 'string' && value.length > 0 && value.length <= maxLength

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

let onlineUsers = []

io.on('connection', socket => {
    console.log(socket.id)

    socket.on('login', payload => {
        const username = isObject(payload) && typeof payload.username === 'string'
            ? payload.username.trim()
            : ''
        const room = isObject(payload) ? payload.room : undefined

        if (!isNonEmptyString(username, MAX_NAME_LENGTH) || !isNonEmptyString(room, MAX_NAME_LENGTH)) {
            socket.emit('loginError', { message: 'Invalid username or room' })
            return
        }

        onlineUsers = onlineUsers.filter(user => user.id !== socket.id)
        onlineUsers.push({ username, id: socket.id, room })
        socket.join(room)
        socket.broadcast.emit('newLogin')
        socket.emit('loggedin')
    })

    socket.on('sendmessage', payload => {
        const message = isObject(payload) ? payload.message : undefined
        const room = isObject(payload) ? payload.room : undefined

        if (
            !isObject(message) ||
            !isNonEmptyString(message.text, MAX_TEXT_LENGTH) ||
            !isNonEmptyString(room, MAX_NAME_LENGTH)
        ) {
            console.warn("dropped invalid sendmessage payload from:", socket.id)
            return
        }

        socket.to(room).emit('message', message)
    })

    socket.on('disconnect', () => {
        console.log("socket disconnected:", socket.id)
        onlineUsers = onlineUsers.filter(user => user.id !== socket.id)
    })
})

app.get('/online-users', (req, res) => {
    res.send( {onlineUsers} )
})

app.use((req, res, next) => next(createError(404)))

// Express identifies an error handler by its four parameters: keep all of them.
app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ message: err.message })
})

const port = process.env.PORT || 3001

console.table(listEndpoints(app))

server.listen(port, () => {
    console.log(" ✅  Server is running on port: " + port)
})
server.on('error', (error) => {
    console.log(" 🚫 Server crashed due to: ", error)
})
