import express from "express"
import cors from 'cors'
import { createServer } from 'http'
import { Server } from 'socket.io'
import listEndpoints from "express-list-endpoints"

const app = express()

app.use(cors())
app.use(express.json())

const server = createServer(app)

const io = new Server(server, { allowEI03: true })

let onlineUsers = []

io.on('connection', socket => {
    console.log(socket.id)

    socket.on('login', ( { username, room} ) => {
        onlineUsers.push({ username, id: socket.id, room })
        console.log(onlineUsers)
    })
})

const port = process.env.PORT || 3001

console.table(listEndpoints(server))

server.listen(port, () => {
    console.log(" ✅  Server is running on port: " + port)
})
server.on('error', (error) => {
    console.log(" 🚫 Server crashed due to: ", error)
})
