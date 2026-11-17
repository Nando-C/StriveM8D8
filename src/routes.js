import { Router } from 'express'
import { isDatabaseReady } from './db.js'

export const createRouter = ({ getOnlineUsers }) => {
    const router = Router()

    router.get('/online-users', (req, res) => {
        res.send({ onlineUsers: getOnlineUsers() })
    })

    // For hosting platforms and uptime checks. Always 200 while the process is alive:
    // the server is designed to stay up, and keep serving presence, without its database.
    router.get('/health', (req, res) => {
        res.send({ status: 'ok', db: isDatabaseReady() ? 'up' : 'down' })
    })

    return router
}
