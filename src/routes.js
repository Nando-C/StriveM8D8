import { Router } from 'express'

export const createRouter = ({ getOnlineUsers }) => {
    const router = Router()

    router.get('/online-users', (req, res) => {
        res.send({ onlineUsers: getOnlineUsers() })
    })

    return router
}
