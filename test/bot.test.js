import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BOT, botReply } from '../src/bot.js'
import { Message } from '../src/models/message.js'
import {
    connectTestDatabase, disconnectTestDatabase, getHistory, login, messageTo, nextEvent, onlineUsers,
    record, send, settle, sortedKeys, startApp,
} from './helpers.js'

const apps = []
const start = async options => {
    const app = await startApp(options)
    apps.push(app)
    return app
}

beforeAll(connectTestDatabase)
afterAll(disconnectTestDatabase)
afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.stop()))
    await Message.deleteMany({})
})

describe('with the demo bot switched off', () => {
    it('lists no bot', async () => {
        const app = await start()
        const alice = await app.client()

        const session = await login(alice, { username: 'alice' })

        expect(session.onlineUsers).toEqual([{ username: 'alice', id: alice.id }])
        expect(await onlineUsers(app)).toEqual([{ username: 'alice', id: alice.id }])
    })

    it('still reserves the bot’s name', async () => {
        const app = await start()
        const impostor = await app.client()

        expect(await login(impostor, { username: BOT.username }))
            .toEqual({ ok: false, message: 'Username already in use' })
        expect(await onlineUsers(app)).toEqual([])
    })
})

describe('with the demo bot switched on', () => {
    it('is online from the start, for REST and for everyone who logs in', async () => {
        const app = await start({ demoBot: true })
        expect(await onlineUsers(app)).toEqual([{ username: 'demo-bot', id: 'demo-bot' }])

        const alice = await app.client()
        const session = await login(alice, { username: 'alice' })

        expect(session.onlineUsers).toEqual([
            { username: 'demo-bot', id: 'demo-bot' },
            { username: 'alice', id: alice.id },
        ])
        expect(JSON.stringify(session.onlineUsers)).not.toContain('sessionToken')
    })

    it('exists only in the app instance that enabled it', async () => {
        const withBot = await start({ demoBot: true })
        const withoutBot = await start()

        expect(await onlineUsers(withBot)).toHaveLength(1)
        expect(await onlineUsers(withoutBot)).toEqual([])
    })

    it('cannot be impersonated or taken over', async () => {
        const app = await start({ demoBot: true })
        const impostor = await app.client()

        for (const payload of [
            { username: 'demo-bot' },
            { username: 'demo-bot', sessionToken: 'null' },
            { username: 'demo-bot', sessionToken: null },
        ]) {
            expect(await login(impostor, payload)).toEqual({ ok: false, message: 'Username already in use' })
        }
        expect(await onlineUsers(app)).toEqual([{ username: 'demo-bot', id: 'demo-bot' }])
    })

    it('acknowledges a message and answers it, to the sender only', async () => {
        const app = await start({ demoBot: true })
        const alice = await app.client()
        const bob = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })
        const seenByBob = record(bob, 'message')

        const answered = nextEvent(alice, 'message')
        const ack = await send(alice, messageTo(BOT.id, 'is anyone there?'))
        const answer = await answered

        expect(ack).toEqual({ ok: true, id: expect.any(String), timestamp: expect.any(Number) })
        expect(sortedKeys(answer)).toEqual(['from', 'fromId', 'id', 'text', 'timestamp'])
        expect(answer).toMatchObject({ from: 'demo-bot', fromId: 'demo-bot', text: botReply('is anyone there?', 0) })
        expect(answer.id).not.toBe(ack.id)
        await settle()
        expect(seenByBob).toEqual([])
    })

    it('keeps the conversation in history like any other, with no client id on its answers', async () => {
        const app = await start({ demoBot: true })
        const alice = await app.client()
        await login(alice, { username: 'alice' })
        const question = messageTo(BOT.id, 'hello')

        const answered = nextEvent(alice, 'message')
        await send(alice, question)
        const answer = await answered

        const history = await getHistory(alice, { withUsername: 'demo-bot' })
        expect(history.messages.map(message => [message.from, message.to, message.text])).toEqual([
            ['alice', 'demo-bot', 'hello'],
            ['demo-bot', 'alice', answer.text],
        ])
        expect(history.messages[0].clientId).toBe(question.clientId)
        expect(history.messages[1].clientId).toBeNull()
        expect(history.messages[1].id).toBe(answer.id)
    })

    it('works through its tips over a conversation', async () => {
        const app = await start({ demoBot: true })
        const alice = await app.client()
        await login(alice, { username: 'alice' })

        const answers = []
        for (const text of ['first', 'second']) {
            const answered = nextEvent(alice, 'message')
            await send(alice, messageTo(BOT.id, text))
            answers.push((await answered).text)
        }

        expect(answers).toEqual([botReply('first', 0), botReply('second', 1)])
        expect(answers[0]).not.toBe(answers[1].replace('second', 'first'))
    })

    it('delivers the answer to the user’s new connection if they reconnected in the meantime', async () => {
        const app = await start({ demoBot: true })
        const first = await app.client()
        const session = await login(first, { username: 'alice' })
        await send(first, messageTo(BOT.id, 'catch me'))

        // Reconnect before the bot's delayed answer goes out.
        const second = await app.client()
        const answered = nextEvent(second, 'message')
        await login(second, { username: 'alice', reservation: session.reservation })

        expect((await answered).from).toBe('demo-bot')
    })

    it('never leaves, and is never announced as having left', async () => {
        const app = await start({ demoBot: true })
        const alice = await app.client()
        const bob = await app.client()
        await login(alice, { username: 'alice' })
        await login(bob, { username: 'bob' })
        const left = record(alice, 'userLeft')

        const bobId = bob.id
        const told = nextEvent(alice, 'userLeft')
        bob.close()
        await told
        await settle()

        expect(left).toEqual([{ id: bobId }])
        expect(await onlineUsers(app)).toContainEqual({ username: 'demo-bot', id: 'demo-bot' })
    })
})

describe('the bot’s replies', () => {
    it('are the same for the same text and turn', () => {
        expect(botReply('anything', 3)).toBe(botReply('anything', 3))
    })

    it('greet a greeting', () => {
        expect(botReply('Hello there', 0)).toMatch(/^Hello! /)
        expect(botReply('hey', 0)).toMatch(/^Hello! /)
    })

    it('quote what was said, shortened if it is long', () => {
        expect(botReply('  what   is this? ', 0)).toMatch(/^You said “what is this\?”\. /)
        const long = botReply('x'.repeat(500), 0)
        expect(long).toContain(`${'x'.repeat(80)}…`)
        expect(long.length).toBeLessThan(300)
    })

    it('cycle through the tips and start again', () => {
        const tips = Array.from({ length: 6 }, (_unused, turn) => botReply('same', turn))
        expect(new Set(tips).size).toBe(6)
        expect(botReply('same', 6)).toBe(tips[0])
    })

    it('never throw on odd input', () => {
        for (const text of ['', '   ', 42, null, undefined]) {
            expect(typeof botReply(text, -3)).toBe('string')
        }
    })
})
