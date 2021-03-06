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
        socket.join(room)
        // console.log(socket.rooms)
        socket.broadcast.emit('newLogin')
        socket.emit('loggedin')
    })

    socket.on('sendmessage', ( {message, room } )=>{
        socket.to(room).emit('message', message)
    })

    socket.on('disconnect', () => {
        console.log("socket disconnected")
        console.log(onlineUsers)
        onlineUsers = onlineUsers.filter(user => user.id !== socket.id)
        console.log(onlineUsers)
    })
})

app.get('/online-users', (req, res) => {
    res.send( {onlineUsers} )
})
const port = process.env.PORT || 3001

console.table(listEndpoints(server))

server.listen(port, () => {
    console.log(" ✅  Server is running on port: " + port)
})
server.on('error', (error) => {
    console.log(" 🚫 Server crashed due to: ", error)
})
