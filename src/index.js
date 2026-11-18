import 'dotenv/config'
import listEndpoints from "express-list-endpoints"
import { createApp } from './app.js'
import { connectDB, isDatabaseReady } from './db.js'
import { ensureConversationIndexes } from './models/conversation.js'
import { Identity, backfillUsernameKeys } from './models/identity.js'
import { ensureMessageIndexes } from './models/message.js'
import { settingsFromEnv } from './settings.js'

const settings = settingsFromEnv(process.env)
const { app, server } = createApp(settings)

const port = process.env.PORT || 3001

// Not awaited: the server comes up, and answers its health check, even while the database
// is unreachable. Nobody can log in until it is: every name is checked against it.
connectDB(process.env.MONGO_CONNECTION)
    .then(async () => {
        // Message expiry is only touched when MESSAGE_TTL_HOURS is set: a positive number
        // of hours turns it on, 0 turns it off. Left unset, whatever the database already
        // has stays — so a development machine pointed at a shared database cannot switch
        // another deployment's expiry off just by starting up.
        if (!isDatabaseReady()) return
        // Names are compared without regard to case; identities stored before that get their key.
        await Identity.init()
        const conflicts = await backfillUsernameKeys()
        if (conflicts > 0) console.warn(` ⚠️  ${conflicts} stored name(s) differ from another only by case and can no longer be used`)

        const ttlHours = settings.messageTtlHours
        if (ttlHours === undefined) return
        await ensureMessageIndexes({ ttlHours })
        // A conversation lasts as long as its newest message does.
        await ensureConversationIndexes({ ttlHours })
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
