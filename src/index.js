import 'dotenv/config'
import listEndpoints from "express-list-endpoints"
import { createApp } from './app.js'
import { connectDB, isDatabaseReady } from './db.js'
import { ensureMessageIndexes } from './models/message.js'

const { app, server } = createApp({ demoBot: process.env.DEMO_BOT === 'true' })

const port = process.env.PORT || 3001

// Not awaited: the server comes up and serves presence even while the database is unreachable.
connectDB(process.env.MONGO_CONNECTION)
    .then(async () => {
        // Message expiry is only touched when MESSAGE_TTL_HOURS is set: a positive number
        // of hours turns it on, 0 turns it off. Left unset, whatever the database already
        // has stays — so a development machine pointed at a shared database cannot switch
        // another deployment's expiry off just by starting up.
        const configured = process.env.MESSAGE_TTL_HOURS
        if (!isDatabaseReady() || configured === undefined || configured.trim() === '') return
        const ttlHours = Number(configured)
        if (!Number.isFinite(ttlHours) || ttlHours < 0) {
            console.warn(" ⚠️  MESSAGE_TTL_HOURS is not a number of hours: message expiry left unchanged")
            return
        }
        await ensureMessageIndexes({ ttlHours })
        console.log(ttlHours > 0 ? ` ✅  Messages expire after ${ttlHours} h` : " ✅  Message expiry is off")
    })
    .catch(error => console.error(" 🚫 Could not apply message expiry:", error.name))

console.table(listEndpoints(app))

server.listen(port, () => {
    console.log(" ✅  Server is running on port: " + port)
})
server.on('error', (error) => {
    console.error(" 🚫 Server could not start: ", error)
    // Exit instead of lingering: the database connection would otherwise keep a
    // process alive that is not listening on anything.
    process.exit(1)
})
