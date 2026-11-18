import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Conversation, ensureConversationIndexes } from '../src/models/conversation.js'
import { Message, ensureMessageIndexes } from '../src/models/message.js'
import { connectTestDatabase, disconnectTestDatabase } from './helpers.js'

// Checks the expiry *rule* only. Actual deletion is MongoDB's job and its background
// task runs about once a minute, so it is not something a fast test can wait for.

const expiryIndex = async () => (await Message.collection.indexes()).find(index => index.name === 'message_expiry')
const conversationIndex = async () =>
    (await Message.collection.indexes()).find(index => 'conversationKey' in index.key)

beforeAll(async () => {
    await connectTestDatabase()
    await Message.init() // builds the schema's own index
})
afterAll(disconnectTestDatabase)
afterEach(() => ensureMessageIndexes())

describe('message expiry', () => {
    it('is off until asked for', async () => {
        expect(await expiryIndex()).toBeUndefined()
    })

    it('expires messages the configured number of hours after they were created', async () => {
        await ensureMessageIndexes({ ttlHours: 24 })

        expect(await expiryIndex()).toMatchObject({ key: { createdAt: 1 }, expireAfterSeconds: 86_400 })
    })

    it('changes the duration in place when asked again with a different value', async () => {
        await ensureMessageIndexes({ ttlHours: 24 })

        await ensureMessageIndexes({ ttlHours: 1 })
        expect((await expiryIndex()).expireAfterSeconds).toBe(3_600)

        await ensureMessageIndexes({ ttlHours: 0.5 })
        expect((await expiryIndex()).expireAfterSeconds).toBe(1_800)
    })

    it('is harmless to repeat', async () => {
        await ensureMessageIndexes({ ttlHours: 24 })
        await ensureMessageIndexes({ ttlHours: 24 })

        expect((await expiryIndex()).expireAfterSeconds).toBe(86_400)
    })

    it.each([[undefined], [0], [-5], [Number.NaN]])('is switched off by %s', async ttlHours => {
        await ensureMessageIndexes({ ttlHours: 24 })

        await ensureMessageIndexes({ ttlHours })

        expect(await expiryIndex()).toBeUndefined()
    })

    it('never touches the index that serves conversations', async () => {
        const before = await conversationIndex()
        expect(before).toBeDefined()

        await ensureMessageIndexes({ ttlHours: 24 })
        await ensureMessageIndexes({ ttlHours: 1 })
        await ensureMessageIndexes()

        expect(await conversationIndex()).toEqual(before)
    })

    it('still lets messages be saved and read with expiry on', async () => {
        await ensureMessageIndexes({ ttlHours: 24 })

        await Message.create({ conversationKey: 'dm:a::b', from: 'a', fromName: 'alice', text: 'kept for a day' })

        expect(await Message.countDocuments()).toBe(1)
        await Message.deleteMany({})
    })
})

describe('conversation expiry', () => {
    const expiry = async () => (await Conversation.collection.indexes()).find(index => index.name === 'conversation_expiry')
    const memberIndex = async () => (await Conversation.collection.indexes()).find(index => 'members.userId' in index.key)

    beforeAll(() => Conversation.init())
    afterEach(() => ensureConversationIndexes())

    it('follows the same rule as messages, counted from the last activity', async () => {
        expect(await expiry()).toBeUndefined()

        await ensureConversationIndexes({ ttlHours: 24 })
        expect(await expiry()).toMatchObject({ key: { lastActivityAt: 1 }, expireAfterSeconds: 86_400 })

        await ensureConversationIndexes({ ttlHours: 1 })
        expect((await expiry()).expireAfterSeconds).toBe(3_600)
    })

    it.each([[undefined], [0]])('is switched off by %s, leaving the index that lists conversations alone', async ttlHours => {
        const before = await memberIndex()
        expect(before).toBeDefined()
        await ensureConversationIndexes({ ttlHours: 24 })

        await ensureConversationIndexes({ ttlHours })

        expect(await expiry()).toBeUndefined()
        expect(await memberIndex()).toEqual(before)
    })
})
