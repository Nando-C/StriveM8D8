import 'dotenv/config'
import listEndpoints from "express-list-endpoints"
import { createApp } from './app.js'
import { connectDB } from './db.js'

const { app, server } = createApp()

const port = process.env.PORT || 3001

// Not awaited: the server comes up and serves presence even while the database is unreachable.
connectDB(process.env.MONGO_CONNECTION)

console.table(listEndpoints(app))

server.listen(port, () => {
    console.log(" ✅  Server is running on port: " + port)
})
server.on('error', (error) => {
    console.log(" 🚫 Server crashed due to: ", error)
})
