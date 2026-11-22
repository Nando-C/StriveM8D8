import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conversation } from '../src/models/conversation.js'
import { File } from '../src/models/file.js'
import { Message } from '../src/models/message.js'
import { resolveSettings, settingsFromEnv } from '../src/settings.js'
import { contentDisposition, isInlineType } from '../src/storage/index.js'
import { createS3Storage } from '../src/storage/s3.js'
import {
    acknowledging, ask, connectTestDatabase, disconnectTestDatabase, dm, getHistory, join, login, messageTo, nextEvent,
    positionOf, record, register, send, settle, startApp,
} from './helpers.js'

// File attachments, against the local driver: a folder of this machine, reached over the
// same kind of signed, short-lived addresses a real bucket gives out.

let app
let directory

beforeAll(async () => {
    await connectTestDatabase()
    directory = await mkdtemp(path.join(tmpdir(), 'strive-files-'))
})
afterAll(async () => {
    await disconnectTestDatabase()
    await rm(directory, { recursive: true, force: true })
})
const start = async (options = {}) => {
    app = await startApp({ fileStorage: 'local', localStorageDir: directory, ...options })
}
beforeEach(() => start())
afterEach(async () => {
    vi.restoreAllMocks()
    await app.stop()
    for (const name of await readdir(directory)) await rm(path.join(directory, name), { force: true })
})

const MB = 1024 * 1024
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const OFF = 'File sharing is not available here'
const UNKNOWN_FILE = 'Unknown file'
const NOT_AVAILABLE = 'An attachment is not available — upload it again'

/** An account, logged in on a client that acknowledges what it is sent. */
const account = async (name, { address, ...extra } = {}) => {
    const socket = acknowledging(await app.client({ address }))
    const registered = await register(socket, name, extra)
    if (!registered.ok) throw new Error(`could not register ${name}: ${registered.message}`)
    return { socket, ...await login(socket, { session: registered.session }) }
}
const guest = async name => {
    const person = await join(app, name)
    acknowledging(person.socket)
    return person
}

const bytesOf = (size, fill = 7) => Buffer.alloc(size, fill)
const photo = (overrides = {}) => ({ name: 'holiday.png', type: 'image/png', size: 2048, width: 640, height: 480, ...overrides })
const reserve = (person, conversationId, file = photo()) => ask(person.socket, 'requestUpload', { conversationId, ...file })
const put = (reserved, body, headers = reserved.headers) => fetch(reserved.uploadUrl, { method: 'PUT', headers, body })

/** Reserves and uploads a file; resolves with its id. */
const upload = async (person, conversationId, file = photo(), body = bytesOf(file.size)) => {
    const reserved = await reserve(person, conversationId, file)
    if (!reserved.ok) throw new Error(`upload refused: ${reserved.message}`)
    const response = await put(reserved, body)
    if (response.status !== 200) throw new Error(`upload failed: ${response.status}`)
    return reserved.fileId
}
const sendWith = (person, conversationId, fileIds, text = '') =>
    send(person.socket, { ...messageTo(conversationId, text), attachments: fileIds })
const urlOf = (person, fileId) => ask(person.socket, 'getFileUrl', { fileId })
const stored = () => readdir(directory)
/** Waits for there to be `count` objects in storage: what a message no longer needs is cleared away after it is answered. */
const storedIs = count => vi.waitFor(async () => expect(await stored()).toHaveLength(count))

describe('sending a file', () => {
    it('goes from the browser to storage and back, without its bytes passing through a socket', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        expect(alice.features).toEqual({ files: true, calls: true, maxFileBytes: 25 * MB, maxFilesPerMessage: 10 })

        // Asked for before the two have ever spoken: the conversation need not exist yet.
        const reserved = await reserve(alice, id)
        expect(reserved).toEqual({
            ok: true, fileId: expect.stringMatching(/^[0-9a-f-]{36}$/), uploadUrl: expect.stringContaining(`${app.url}/files/`),
            headers: { 'Content-Type': 'image/png' }, expiresInSeconds: 900,
        })
        const body = bytesOf(2048, 42)
        expect((await put(reserved, body)).status).toBe(200)

        const arrives = nextEvent(bob.socket, 'message')
        const sent = await sendWith(alice, id, [reserved.fileId])
        expect(sent).toMatchObject({ ok: true })
        const attachment = { id: reserved.fileId, name: 'holiday.png', type: 'image/png', size: 2048, width: 640, height: 480 }
        // Files alone: no text. And nothing says where the file is stored.
        expect(await arrives).toMatchObject({ id: sent.id, kind: 'text', text: '', attachments: [attachment] })
        const history = await getHistory(bob.socket, { conversationId: id })
        expect(history.messages).toEqual([expect.objectContaining({ id: sent.id, attachments: [attachment] })])
        expect(JSON.stringify(history)).not.toContain('files/')

        // Bob — a guest — may fetch it, with an address of his own that lasts a few minutes.
        const link = await urlOf(bob, reserved.fileId)
        expect(link).toEqual({ ok: true, url: expect.stringContaining(`${app.url}/files/`), expiresInSeconds: 300 })
        const response = await fetch(link.url)
        expect(response.status).toBe(200)
        expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(response.headers.get('content-disposition')).toMatch(/^inline; filename="holiday\.png"/)
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')

        // The list says a file was sent, since there are no words to show.
        const view = (await login(await app.client(), { username: 'bob', reservation: bob.reservation })).conversations[0]
        expect(view.lastMessage).toMatchObject({ id: sent.id, preview: '', attachments: 1 })
    })

    it('can go with words, and several at a time — ten at most', async () => {
        const alice = await account('alice', {}, { uploadMaxFileMb: 1 })
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const first = await upload(alice, id)
        const second = await upload(alice, id, photo({ name: 'notes.pdf', type: 'application/pdf', size: 10, width: undefined, height: undefined }))

        const arrives = nextEvent(bob.socket, 'message')
        expect((await sendWith(alice, id, [second, first], 'two things')).ok).toBe(true)
        const message = await arrives
        expect(message.text).toBe('two things')
        // In the order they were named, each with only what is known of it.
        expect(message.attachments).toEqual([
            { id: second, name: 'notes.pdf', type: 'application/pdf', size: 10 },
            expect.objectContaining({ id: first, width: 640 }),
        ])

        const eleven = Array.from({ length: 11 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
        expect(await sendWith(alice, id, eleven)).toEqual({ ok: false, message: 'Invalid message' })
        expect(await sendWith(alice, id, [first, first])).toEqual({ ok: false, message: 'Invalid message' })
        // Neither words nor files is still nothing to send.
        expect(await sendWith(alice, id, [], '   ')).toEqual({ ok: false, message: 'Invalid message' })
    })

    it('keeps only what a client may say about a file: a label for a name, a real shape, a small preview', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const placeholder = `data:image/webp;base64,${Buffer.alloc(60, 1).toString('base64')}`
        const fileId = await upload(alice, id, photo({
            name: '  ../../etc/pass\nwd.png ', width: 640, height: -1, durationMs: 1500, placeholder,
        }))
        const arrives = nextEvent(bob.socket, 'message')
        await sendWith(alice, id, [fileId])
        const [attachment] = (await arrives).attachments
        expect(attachment).toEqual({ id: fileId, name: '.._.._etc_pass_wd.png', type: 'image/png', size: 2048, durationMs: 1500, placeholder })

        // A "preview" that is not a small image is dropped, not stored.
        const other = await upload(alice, id, photo({ placeholder: 'data:text/html;base64,PHNjcmlwdD4=' }))
        const next = nextEvent(bob.socket, 'message')
        await sendWith(alice, id, [other])
        expect((await next).attachments[0]).not.toHaveProperty('placeholder')
    })
})

describe('where file sharing is not set up', () => {
    it('says so at login, and refuses everything to do with files', async () => {
        await app.stop()
        app = await startApp()
        const alice = await account('alice')
        const bob = await guest('bob')
        expect(alice.features).toEqual({ files: false, calls: true })
        expect(await reserve(alice, dm(alice, bob))).toEqual({ ok: false, message: OFF })
        expect(await urlOf(alice, '00000000-0000-4000-8000-000000000000')).toEqual({ ok: false, message: OFF })
        expect(await sendWith(alice, dm(alice, bob), ['00000000-0000-4000-8000-000000000000'], 'hi')).toEqual({ ok: false, message: OFF })
        // Messages themselves are as they were.
        expect((await send(alice.socket, messageTo(dm(alice, bob)))).ok).toBe(true)
    })
})

describe('asking to upload', () => {
    it('is for accounts, in a conversation they are in, with a file that makes sense', async () => {
        await app.stop()
        await start({ uploadMaxFileMb: 1 })
        const alice = await account('alice')
        const bob = await guest('bob')
        const carol = await guest('carol')
        const id = dm(alice, bob)

        // A guest can receive files, and cannot send them.
        expect(await reserve(bob, id)).toEqual({ ok: false, message: 'Create an account to send files' })
        // Somebody else's conversation, and one that could not exist.
        expect(await reserve(alice, dm(bob, carol))).toEqual({ ok: false, message: 'Unknown conversation' })
        expect(await reserve(alice, 'group:nothing')).toEqual({ ok: false, message: 'Unknown conversation' })
        expect(await reserve(alice, dm(alice, '00000000-0000-4000-8000-000000000000'))).toEqual({ ok: false, message: 'Unknown conversation' })

        for (const broken of [{ type: 'png' }, { type: 'image/png; charset=x' }, { type: '' }, { name: '' }, { name: 5 }, { size: 0 }, { size: 1.5 }, { size: '2048' }]) {
            expect(await reserve(alice, id, photo(broken))).toEqual({ ok: false, message: 'Invalid file' })
        }
        expect(await reserve(alice, id, photo({ size: MB + 1 }))).toEqual({ ok: false, message: 'A file can be at most 1 MB' })
        expect((await reserve(alice, id, photo({ size: MB }))).ok).toBe(true)
        // Nothing that was refused left anything behind.
        expect(await File.countDocuments()).toBe(1)
    })

    it('is refused in a conversation whose other person is gone, and to someone taken out of a group', async () => {
        const alice = await account('alice')
        const bob = await account('bob')
        const carol = await guest('carol')
        const created = await ask(alice.socket, 'createGroup', { name: 'Trip', userIds: [bob.userId, carol.userId] })
        expect((await reserve(bob, created.conversationId)).ok).toBe(true)
        await ask(alice.socket, 'removeMember', { conversationId: created.conversationId, userId: bob.userId })
        expect(await reserve(bob, created.conversationId)).toEqual({ ok: false, message: 'Unknown conversation' })
    })

    it('holds one account to five uploads that are waiting to be sent', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const first = await upload(alice, id)
        for (let more = 0; more < 4; more += 1) expect((await reserve(alice, id)).ok).toBe(true)
        expect(await reserve(alice, id)).toEqual({ ok: false, message: 'Send or remove what you have already attached first (at most 5 at a time)' })

        // Sending one makes room for another.
        expect((await sendWith(alice, id, [first])).ok).toBe(true)
        expect((await reserve(alice, id)).ok).toBe(true)
    })

    it('can be taken back before sending: free if nothing was uploaded, otherwise deleted and still charged', async () => {
        await app.stop()
        await start({ uploadMaxUserMbPerDay: 0.01 })
        const alice = await account('alice')
        const bob = await account('bob')
        const id = dm(alice, bob)
        const cancel = (person, fileId) => ask(person.socket, 'cancelUpload', { fileId })

        const empty = (await reserve(alice, id, photo({ size: 6000 }))).fileId
        // Only one's own, and only while it waits.
        expect(await cancel(bob, empty)).toEqual({ ok: false, message: UNKNOWN_FILE })
        expect(await cancel(alice, empty)).toEqual({ ok: true })
        expect(await cancel(alice, empty)).toEqual({ ok: false, message: UNKNOWN_FILE })
        // Its address still works, so it still counts — until the address is dead; then it has cost nothing.
        expect(await File.find().lean()).toMatchObject([{ state: 'unused' }])
        expect((await reserve(alice, id, photo({ size: 6000 }))).ok).toBe(false)
        await app.sweepPendingUploads({ now: Date.now() + 31 * MINUTE })
        expect(await File.countDocuments()).toBe(0)

        const uploaded = await upload(alice, id, photo({ size: 6000 }))
        expect(await cancel(alice, uploaded)).toEqual({ ok: true })
        await storedIs(0)
        expect(await sendWith(alice, id, [uploaded])).toEqual({ ok: false, message: NOT_AVAILABLE })
        expect(await reserve(alice, id, photo({ size: 6000 }))).toEqual({ ok: false, message: 'You have reached your upload limit for today' })

        const sent = await upload(bob, id)
        await sendWith(bob, id, [sent])
        expect(await cancel(bob, sent)).toEqual({ ok: false, message: UNKNOWN_FILE })
    })
})

describe('allowances', () => {
    it('one account can upload only so much in a day, whether or not it sends what it uploads', async () => {
        await app.stop()
        await start({ uploadMaxUserMbPerDay: 0.01 })   // about 10 kB
        const alice = await account('alice')
        const bob = await account('bob')
        const id = dm(alice, bob)

        const sent = await upload(alice, id, photo({ size: 6000 }))
        expect((await sendWith(alice, id, [sent])).ok).toBe(true)
        expect((await reserve(alice, id, photo({ size: 4000 }))).ok).toBe(true)
        expect(await reserve(alice, id, photo({ size: 1000 }))).toEqual({ ok: false, message: 'You have reached your upload limit for today' })
        // It is hers alone: bob's day is untouched.
        expect((await reserve(bob, id, photo({ size: 6000 }))).ok).toBe(true)

        // Yesterday's uploads no longer count.
        await File.updateMany({ uploader: alice.userId }, { createdAt: new Date(Date.now() - 25 * HOUR) })
        expect((await reserve(alice, id, photo({ size: 6000 }))).ok).toBe(true)
    })

    it('everything from one address shares an allowance too, unless that is switched off', async () => {
        await app.stop()
        await start({ uploadMaxUserMbPerDay: 0.01, uploadMaxAddressMbPerDay: 0.012, trustedProxyHops: 1 })
        const alice = await account('alice', { address: '203.0.113.7' })
        const bob = await account('bob', { address: '203.0.113.7' })
        const carol = await account('carol', { address: '198.51.100.9' })
        const id = dm(alice, bob)

        expect((await reserve(alice, id, photo({ size: 8000 }))).ok).toBe(true)
        // Bob has used nothing himself — but shares alice's address.
        expect(await reserve(bob, id, photo({ size: 8000 }))).toEqual({ ok: false, message: 'Too much has been uploaded from this network today' })
        expect((await reserve(carol, dm(carol, alice), photo({ size: 8000 }))).ok).toBe(true)

        await app.stop()
        await start({ uploadMaxUserMbPerDay: 0.01, uploadMaxAddressMbPerDay: 0, trustedProxyHops: 1 })
        const dave = await account('dave', { address: '203.0.113.7' })
        const erin = await account('erin', { address: '203.0.113.7' })
        expect((await reserve(dave, dm(dave, erin), photo({ size: 8000 }))).ok).toBe(true)
        expect((await reserve(erin, dm(dave, erin), photo({ size: 8000 }))).ok).toBe(true)
    })

    it('defaults the address allowance to four times one account’s', () => {
        expect(resolveSettings({})).toMatchObject({ uploadMaxUserMbPerDay: 200, uploadMaxAddressMbPerDay: 800 })
        expect(resolveSettings({ uploadMaxUserMbPerDay: 50 }).uploadMaxAddressMbPerDay).toBe(200)
        expect(resolveSettings({ uploadMaxUserMbPerDay: 50, uploadMaxAddressMbPerDay: 0 }).uploadMaxAddressMbPerDay).toBe(0)
        expect(() => resolveSettings({ fileStorage: 'ftp' })).toThrow(/fileStorage/)
        expect(() => resolveSettings({ fileStorage: 's3' })).toThrow(/s3\.bucket/)
    })

    it('nobody can upload once storage is full, until something goes', async () => {
        await app.stop()
        await start({ uploadMaxTotalMb: 0.01 })
        const alice = await account('alice')
        const bob = await account('bob')
        const id = dm(alice, bob)
        const big = await upload(alice, id, photo({ size: 9000 }))
        const sent = await sendWith(alice, id, [big])

        expect(await reserve(bob, id, photo({ size: 2000 }))).toEqual({ ok: false, message: 'Storage is full — no more files can be uploaded for now' })
        expect(await ask(alice.socket, 'deleteMessage', { id: sent.id })).toEqual({ ok: true })
        expect((await reserve(bob, id, photo({ size: 2000 }))).ok).toBe(true)
    })

    it('are not got around by asking for several uploads at the same moment', async () => {
        await app.stop()
        await start({ uploadMaxUserMbPerDay: 0.01 })
        const alice = await account('alice')
        const bob = await guest('bob')
        const answers = await Promise.all(Array.from({ length: 5 }, () => reserve(alice, dm(alice, bob), photo({ size: 4000 }))))
        expect(answers.filter(answer => answer.ok).length).toBeLessThanOrEqual(2)
        expect(await File.countDocuments()).toBe(answers.filter(answer => answer.ok).length)
    })
})

describe('the address a file is uploaded to', () => {
    it('takes exactly the file it was given for, once declared as what it is', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const reserved = await reserve(alice, dm(alice, bob))

        expect((await put(reserved, bytesOf(2048), { 'Content-Type': 'text/html' })).status).toBe(400)
        expect((await put(reserved, bytesOf(2047))).status).toBe(400)
        expect((await put(reserved, bytesOf(4096))).status).toBe(400)
        await storedIs(0)

        // An address that was not signed here, and one that was signed for something else.
        const [base, signature] = reserved.uploadUrl.split(/\.(?=[^.]*$)/)
        const forged = Buffer.from(JSON.stringify({ op: 'put', key: 'files/00000000-0000-4000-8000-000000000000', type: 'image/png', size: 2048, exp: Date.now() + MINUTE })).toString('base64url')
        expect((await fetch(`${app.url}/files/${forged}.${signature}`, { method: 'PUT', headers: reserved.headers, body: bytesOf(2048) })).status).toBe(403)
        expect((await fetch(`${base}.${signature.slice(0, -2)}xx`, { method: 'PUT', headers: reserved.headers, body: bytesOf(2048) })).status).toBe(403)
        expect((await fetch(reserved.uploadUrl)).status).toBe(403)
        expect((await fetch(`${app.url}/files/nonsense`)).status).toBe(403)

        expect((await put(reserved, bytesOf(2048))).status).toBe(200)
        await storedIs(1)
    })
})

describe('attaching', () => {
    it('takes only one’s own upload, for this conversation, that really arrived, once', async () => {
        const alice = await account('alice')
        const bob = await account('bob')
        const carol = await guest('carol')
        const id = dm(alice, bob)

        // Somebody else's upload.
        const bobs = await upload(bob, id)
        expect(await sendWith(alice, id, [bobs])).toEqual({ ok: false, message: NOT_AVAILABLE })
        // One's own, uploaded for another conversation.
        const elsewhere = await upload(alice, dm(alice, carol))
        expect(await sendWith(alice, id, [elsewhere])).toEqual({ ok: false, message: NOT_AVAILABLE })
        // A file there never was.
        expect(await sendWith(alice, id, ['00000000-0000-4000-8000-000000000000'])).toEqual({ ok: false, message: NOT_AVAILABLE })
        // Reserved, and never uploaded.
        const empty = (await reserve(alice, id)).fileId
        expect(await sendWith(alice, id, [empty])).toEqual({ ok: false, message: 'An attachment was not uploaded completely' })
        // Nothing was sent, and nothing was used up by trying.
        expect(await Message.countDocuments()).toBe(0)
        expect(await File.countDocuments({ state: 'pending' })).toBe(3)

        // One that is refused does not take the others with it into a message.
        const good = await upload(alice, id)
        expect(await sendWith(alice, id, [good, empty])).toEqual({ ok: false, message: 'An attachment was not uploaded completely' })
        expect((await sendWith(alice, id, [good])).ok).toBe(true)
        // And a file is in one message only.
        expect(await sendWith(alice, id, [good])).toEqual({ ok: false, message: NOT_AVAILABLE })
        expect(await Message.countDocuments()).toBe(1)
    })
})

describe('a message with files that could not be saved', () => {
    it('gives its files back, to be sent again', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const fileId = await upload(alice, id)
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const failing = vi.spyOn(Message, 'create').mockRejectedValueOnce(Object.assign(new Error('down'), { name: 'MongoNetworkError' }))
        try {
            expect(await sendWith(alice, id, [fileId])).toEqual({ ok: false, message: 'Message could not be saved' })
        } finally {
            failing.mockRestore()
        }
        expect(await File.findById(fileId).lean()).toMatchObject({ state: 'pending' })
        expect((await sendWith(alice, id, [fileId])).ok).toBe(true)
    })
})

describe('fetching a file', () => {
    it('is for whoever could read the message it came with, and nobody else', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const carol = await guest('carol')
        const dave = await guest('dave')
        const told = [alice, bob].map(person => nextEvent(person.socket, 'message'))
        const { conversationId: id } = await ask(alice.socket, 'createGroup', { name: 'Trip', userIds: [bob.userId] })
        await Promise.all(told)

        const early = await upload(alice, id)
        await sendWith(alice, id, [early])
        // Still waiting to be sent: nobody can fetch it, its uploader included.
        const waiting = await upload(alice, id)
        expect(await urlOf(alice, waiting)).toEqual({ ok: false, message: UNKNOWN_FILE })

        // Carol joins later: what was sent before is not hers to fetch, any more than to read.
        await ask(alice.socket, 'addMembers', { conversationId: id, userIds: [carol.userId] })
        const late = await upload(alice, id)
        await sendWith(alice, id, [late])
        expect(await urlOf(carol, early)).toEqual({ ok: false, message: UNKNOWN_FILE })
        expect((await urlOf(carol, late)).ok).toBe(true)
        expect((await urlOf(bob, early)).ok).toBe(true)

        // Someone who is not in the group; a file that does not exist; something that is not an id.
        expect(await urlOf(dave, late)).toEqual({ ok: false, message: UNKNOWN_FILE })
        expect(await urlOf(bob, '00000000-0000-4000-8000-000000000000')).toEqual({ ok: false, message: UNKNOWN_FILE })
        expect(await urlOf(bob, { $ne: null })).toEqual({ ok: false, message: UNKNOWN_FILE })

        // Taken out of the group: no new addresses.
        await ask(alice.socket, 'removeMember', { conversationId: id, userId: bob.userId })
        expect(await urlOf(bob, early)).toEqual({ ok: false, message: UNKNOWN_FILE })
    })

    it('shows in the page only what cannot do anything there: the rest is a download', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const disposition = async file => {
            const fileId = await upload(alice, id, file)
            await sendWith(alice, id, [fileId])
            const response = await fetch((await urlOf(bob, fileId)).url)
            return [response.headers.get('content-type'), response.headers.get('content-disposition').split(';')[0]]
        }
        expect(await disposition(photo({ name: 'x.svg', type: 'image/svg+xml', size: 30 }))).toEqual(['image/svg+xml', 'attachment'])
        expect(await disposition(photo({ name: 'x.html', type: 'text/html', size: 30 }))).toEqual(['text/html', 'attachment'])
        expect(await disposition(photo({ name: 'x.zip', type: 'application/zip', size: 30 }))).toEqual(['application/zip', 'attachment'])
        expect(await disposition(photo({ name: 'x.mp4', type: 'video/mp4', size: 30 }))).toEqual(['video/mp4', 'inline'])
        expect(await disposition(photo({ name: 'x.mov', type: 'video/quicktime', size: 30 }))).toEqual(['video/quicktime', 'inline'])
        expect(await disposition(photo({ name: 'x.pdf', type: 'application/pdf', size: 30 }))).toEqual(['application/pdf', 'inline'])

        // Asked for to be saved, even a picture comes as a download.
        const fileId = await upload(alice, id)
        await sendWith(alice, id, [fileId])
        const saved = await fetch((await ask(bob.socket, 'getFileUrl', { fileId, download: true })).url)
        expect(saved.headers.get('content-disposition')).toMatch(/^attachment; filename="holiday\.png"/)
    })

    it('can be asked for in part, which is what lets a video be sought', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const body = Buffer.from(Array.from({ length: 100 }, (_, index) => index))
        const fileId = await upload(alice, id, photo({ name: 'clip.mp4', type: 'video/mp4', size: 100 }), body)
        await sendWith(alice, id, [fileId])
        const { url } = await urlOf(bob, fileId)
        const part = async range => {
            const response = await fetch(url, { headers: { Range: range } })
            return [response.status, response.headers.get('content-range'), [...Buffer.from(await response.arrayBuffer())]]
        }

        expect((await fetch(url)).headers.get('accept-ranges')).toBe('bytes')
        expect(await part('bytes=0-3')).toEqual([206, 'bytes 0-3/100', [0, 1, 2, 3]])
        expect(await part('bytes=96-')).toEqual([206, 'bytes 96-99/100', [96, 97, 98, 99]])
        expect(await part('bytes=-2')).toEqual([206, 'bytes 98-99/100', [98, 99]])
        expect(await part('bytes=98-500')).toEqual([206, 'bytes 98-99/100', [98, 99]])
        expect(await part('bytes=100-')).toEqual([416, 'bytes */100', []])
        // Anything else is answered with the whole file.
        expect((await part('lines=1-2'))[0]).toBe(200)
    })
})

describe('what was sent cannot be replaced', () => {
    it('the address a file was uploaded to goes on working, but the message no longer looks there', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const reserved = await reserve(alice, id, photo({ size: 100 }))
        expect((await put(reserved, bytesOf(100, 1))).status).toBe(200)
        expect(await sendWith(alice, id, [reserved.fileId])).toMatchObject({ ok: true })
        const bytesBobGets = async () => Buffer.from(await (await fetch((await urlOf(bob, reserved.fileId)).url)).arrayBuffer())
        expect((await bytesBobGets()).equals(bytesOf(100, 1))).toBe(true)
        // Only the message's own copy is kept.
        await storedIs(1)

        // Other bytes of the same size and type, to the same address, after the fact.
        expect((await put(reserved, bytesOf(100, 2))).status).toBe(200)
        expect((await bytesBobGets()).equals(bytesOf(100, 1))).toBe(true)

        // What arrived late is deleted once the address is dead; the message's file stays.
        await storedIs(2)
        await app.sweepPendingUploads({ now: Date.now() + 31 * MINUTE })
        await storedIs(1)
        expect((await bytesBobGets()).equals(bytesOf(100, 1))).toBe(true)
        expect((await File.findById(reserved.fileId).lean()).uploadKey).toBeUndefined()
    })

    it('files attached by a write that then failed are not left attached to a message that never was', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const first = await upload(alice, id)
        const second = await upload(alice, id)
        const write = File.bulkWrite.bind(File)
        // (The first write notes where the copies are going; the second attaches them.)
        vi.spyOn(File, 'bulkWrite').mockImplementationOnce(write).mockImplementationOnce(async operations => {
            await write(operations.slice(0, 1))
            throw new Error('connection lost')
        })
        expect((await sendWith(alice, id, [first, second])).ok).toBe(false)
        expect(await File.find({ state: 'pending' }).countDocuments()).toBe(2)
        // One object each, and no more: the copies nothing uses are gone.
        await storedIs(2)
        // They can be sent after all.
        expect(await sendWith(alice, id, [first, second])).toMatchObject({ ok: true })
        await storedIs(2)
    })

    it('a copy left behind when everything failed at once is found and deleted later', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const fileId = await upload(alice, id)
        const write = File.bulkWrite.bind(File)
        const find = File.find.bind(File)
        // The database goes away after the copy was made: nothing is attached, and nothing can be tidied.
        vi.spyOn(File, 'bulkWrite').mockImplementationOnce(write).mockRejectedValueOnce(new Error('connection lost'))
        vi.spyOn(File, 'find').mockImplementationOnce(find).mockImplementationOnce(() => ({ lean: () => Promise.reject(new Error('connection lost')) }))
        vi.spyOn(console, 'error').mockImplementation(() => {})
        expect((await sendWith(alice, id, [fileId])).ok).toBe(false)
        await storedIs(2)
        expect(await File.findById(fileId).lean()).toMatchObject({ state: 'pending', copyKey: expect.stringMatching(/^files\//) })

        await app.sweepPendingUploads({ now: Date.now() + 4 * MINUTE })
        await storedIs(2)
        await app.sweepPendingUploads({ now: Date.now() + 6 * MINUTE })
        await storedIs(1)
        expect((await File.findById(fileId).lean()).copyKey).toBeUndefined()
        // The file itself was not touched: it can still be sent.
        expect(await sendWith(alice, id, [fileId])).toMatchObject({ ok: true })
        await storedIs(1)
        expect((await fetch((await urlOf(bob, fileId)).url)).status).toBe(200)
    })

    it('a message that was refused keeps its files to be sent again — once', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const fileId = await upload(alice, id)
        vi.spyOn(Message, 'create').mockRejectedValueOnce(new Error('down'))
        expect((await sendWith(alice, id, [fileId])).ok).toBe(false)
        expect(await File.findById(fileId).lean()).toMatchObject({ state: 'pending' })
        await storedIs(1)
        expect(await sendWith(alice, id, [fileId])).toMatchObject({ ok: true })
        await storedIs(1)
        expect((await fetch((await urlOf(bob, fileId)).url)).status).toBe(200)
    })
})

describe('deleting, in the corners', () => {
    it('a message from before messages had kinds can be deleted by its author', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const sent = await send(alice.socket, messageTo(dm(alice, bob), 'an old one'))
        await Message.collection.updateOne({ clientId: { $exists: true } }, { $unset: { kind: 1 } })
        expect((await Message.collection.findOne({})).kind).toBeUndefined()
        expect(await ask(alice.socket, 'deleteMessage', { id: sent.id })).toEqual({ ok: true })
        expect((await Message.findById(sent.id).lean()).kind).toBe('deleted')
    })

    it('files sent into a conversation that is deleted at that moment go with it', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        await send(alice.socket, messageTo(id, 'hello'))
        const fileId = await upload(alice, id)
        const create = Message.create.bind(Message)
        vi.spyOn(Message, 'create').mockImplementationOnce(async document => {
            const saved = await create(document)
            await Conversation.deleteOne({ _id: id })
            return saved
        })
        await sendWith(alice, id, [fileId])
        await storedIs(0)
        expect(await File.findById(fileId).lean()).toMatchObject({ state: 'discarded' })
    })
})

describe('uploads that were never sent', () => {
    const later = () => app.sweepPendingUploads({ now: Date.now() + 16 * MINUTE })

    it('cost nothing if nothing was uploaded: the reservation is undone', async () => {
        await app.stop()
        await start({ uploadMaxUserMbPerDay: 0.01 })
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        expect((await reserve(alice, id, photo({ size: 9000 }))).ok).toBe(true)
        expect((await reserve(alice, id, photo({ size: 9000 }))).ok).toBe(false)

        // Not yet: an upload has fifteen minutes.
        expect(await app.sweepPendingUploads({ now: Date.now() + 14 * MINUTE })).toEqual({ refunded: 0, discarded: 0 })
        expect(await later()).toEqual({ refunded: 1, discarded: 0 })
        // Counted for as long as its address might still be used, and not a moment longer.
        expect(await File.find().lean()).toMatchObject([{ state: 'unused' }])
        expect((await reserve(alice, id, photo({ size: 9000 }))).ok).toBe(false)
        await app.sweepPendingUploads({ now: Date.now() + 31 * MINUTE })
        expect(await File.countDocuments()).toBe(0)
        expect((await reserve(alice, id, photo({ size: 9000 }))).ok).toBe(true)
    })

    it('are deleted if something was — and still count against the day, though no longer against storage', async () => {
        await app.stop()
        await start({ uploadMaxUserMbPerDay: 0.01, uploadMaxTotalMb: 0.01 })
        const alice = await account('alice')
        const bob = await account('bob')
        const id = dm(alice, bob)
        const fileId = await upload(alice, id, photo({ size: 9000 }))
        await storedIs(1)

        expect(await later()).toEqual({ refunded: 0, discarded: 1 })
        await storedIs(0)
        expect(await File.findById(fileId).lean()).toMatchObject({ state: 'discarded', size: 9000 })
        // It can no longer be sent…
        expect(await sendWith(alice, id, [fileId])).toEqual({ ok: false, message: NOT_AVAILABLE })
        // …alice has still used up her day…
        expect(await reserve(alice, id, photo({ size: 9000 }))).toEqual({ ok: false, message: 'You have reached your upload limit for today' })
        // …and the room it took is free again, for anyone.
        expect((await reserve(bob, id, photo({ size: 9000 }))).ok).toBe(true)
    })

    it('leave nothing behind when the upload arrives after it was given up', async () => {
        await app.stop()
        await start({ uploadMaxUserMbPerDay: 0.01, uploadMaxTotalMb: 0.01 })
        const alice = await account('alice')
        const bob = await account('bob')
        const id = dm(alice, bob)
        // Taken back before anything was uploaded. But the address still works…
        const cancelled = await reserve(alice, id, photo({ size: 6000 }))
        expect(await ask(alice.socket, 'cancelUpload', { fileId: cancelled.fileId })).toEqual({ ok: true })
        expect((await put(cancelled, bytesOf(6000))).status).toBe(200)
        // …and so does that of one the sweep gave up on.
        const swept = await reserve(alice, id, photo({ size: 3000 }))
        expect(await later()).toEqual({ refunded: 1, discarded: 0 })
        expect((await put(swept, bytesOf(3000))).status).toBe(200)
        await storedIs(2)
        // Neither can be sent — and what is there is counted: against her day, and against storage.
        expect(await sendWith(alice, id, [cancelled.fileId])).toEqual({ ok: false, message: NOT_AVAILABLE })
        expect(await reserve(alice, id, photo({ size: 2000 }))).toEqual({ ok: false, message: 'You have reached your upload limit for today' })
        expect(await reserve(bob, id, photo({ size: 2000 }))).toEqual({ ok: false, message: 'Storage is full — no more files can be uploaded for now' })

        // Once no address can still be in use, what arrived is deleted, and the records with it.
        await app.sweepPendingUploads({ now: Date.now() + 29 * MINUTE })
        await storedIs(2)
        await app.sweepPendingUploads({ now: Date.now() + 31 * MINUTE })
        await storedIs(0)
        // Given up and then uploaded all the same: charged to the day after all, like any upload not sent…
        expect((await File.find().lean()).map(file => file.state)).toEqual(['discarded', 'discarded'])
        expect(await reserve(alice, id, photo({ size: 2000 }))).toEqual({ ok: false, message: 'You have reached your upload limit for today' })
        // …though no longer to storage, where nothing of it is left.
        expect((await reserve(bob, id, photo({ size: 9000 }))).ok).toBe(true)
    })

    it('are left alone once sent, however long ago', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const fileId = await upload(alice, dm(alice, bob))
        await sendWith(alice, dm(alice, bob), [fileId])
        expect(await later()).toEqual({ refunded: 0, discarded: 0 })
        expect((await urlOf(bob, fileId)).ok).toBe(true)
    })
})

describe('files and expiry', () => {
    it('a file lasts as long as its message: then its object and its record are deleted', async () => {
        await app.stop()
        await start({ messageTtlHours: 2 })
        const alice = await account('alice')
        const bob = await guest('bob')
        const fileId = await upload(alice, dm(alice, bob))
        const sent = await sendWith(alice, dm(alice, bob), [fileId])
        expect((await File.findById(fileId).lean()).expiresAt.getTime()).toBe(sent.timestamp + 2 * HOUR)

        expect(await app.sweepExpiredFiles({ now: Date.now() + HOUR })).toEqual({ expired: 0 })
        expect(await app.sweepExpiredFiles({ now: Date.now() + 3 * HOUR })).toEqual({ expired: 1 })
        await storedIs(0)
        expect(await File.countDocuments()).toBe(0)
    })

    it.each([[0], [undefined]])('with expiry at %s, files are kept', async messageTtlHours => {
        await app.stop()
        await start({ messageTtlHours })
        const alice = await account('alice')
        const bob = await guest('bob')
        const fileId = await upload(alice, dm(alice, bob))
        await sendWith(alice, dm(alice, bob), [fileId])
        expect(await File.findById(fileId).lean()).not.toHaveProperty('expiresAt')
        expect(await app.sweepExpiredFiles({ now: Date.now() + 10_000 * HOUR })).toEqual({ expired: 0 })
        await storedIs(1)
    })

    it('what is kept only for a day’s allowance is dropped when the day is over', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        await upload(alice, dm(alice, bob))
        await app.sweepPendingUploads({ now: Date.now() + 16 * MINUTE })
        expect(await File.countDocuments({ state: 'discarded' })).toBe(1)
        await app.sweepExpiredFiles({ now: Date.now() + 23 * HOUR })
        expect(await File.countDocuments()).toBe(1)
        await app.sweepExpiredFiles({ now: Date.now() + 25 * HOUR })
        expect(await File.countDocuments()).toBe(0)
    })

    it('a group that is deleted takes its files with it', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const told = [alice, bob].map(person => nextEvent(person.socket, 'message'))
        const { conversationId: id } = await ask(alice.socket, 'createGroup', { name: 'Trip', userIds: [bob.userId] })
        await Promise.all(told)
        const fileId = await upload(alice, id)
        await sendWith(alice, id, [fileId])

        await ask(alice.socket, 'leaveGroup', { conversationId: id })
        await ask(bob.socket, 'leaveGroup', { conversationId: id })
        await settle()
        expect(await Conversation.findById(id)).toBeNull()
        await storedIs(0)
        expect(await File.countDocuments({ state: { $in: ['pending', 'attached'] } })).toBe(0)
    })
})

describe('deleting a message', () => {
    it('leaves a marker where it stood: its words and files are gone, for everyone', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const id = dm(alice, bob)
        const first = await send(alice.socket, messageTo(id, 'keep this'))
        const fileId = await upload(alice, id)
        const second = await sendWith(alice, id, [fileId], 'and delete this')
        await settle()

        const told = [alice, bob].map(person => nextEvent(person.socket, 'messageDeleted'))
        const described = nextEvent(bob.socket, 'conversationUpdated')
        expect(await ask(alice.socket, 'deleteMessage', { id: second.id })).toEqual({ ok: true })
        expect(await Promise.all(told)).toEqual([{ conversationId: id, id: second.id }, { conversationId: id, id: second.id }])

        // It was the last thing said: its words must not stay under the name in bob's list — nor count as unread.
        const view = (await described).conversation
        expect(view.lastMessage).toEqual({ id: second.id, from: alice.userId, fromName: 'alice', preview: '', timestamp: second.timestamp, kind: 'deleted' })
        expect(view.unreadCount).toBe(1)

        const history = await getHistory(bob.socket, { conversationId: id })
        expect(history.messages.map(message => [message.id, message.kind, message.text])).toEqual([
            [first.id, 'text', 'keep this'], [second.id, 'deleted', null],
        ])
        expect(history.messages[1]).not.toHaveProperty('attachments')
        expect(JSON.stringify(await Message.findById(second.id).lean())).not.toContain('delete this')
        // The file is gone from storage, and nobody can fetch it.
        await storedIs(0)
        expect(await urlOf(bob, fileId)).toEqual({ ok: false, message: UNKNOWN_FILE })
        // Positions that pointed at it still mean what they meant.
        expect(await ask(bob.socket, 'markRead', { conversationId: id, upTo: positionOf(second) })).toEqual({ ok: true })
    })

    it('is for one’s own messages only, once, and not for what happened to a group', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const carol = await guest('carol')
        const line = nextEvent(alice.socket, 'message')
        const { conversationId: id } = await ask(alice.socket, 'createGroup', { name: 'Trip', userIds: [bob.userId] })
        const created = await line
        const hers = await send(alice.socket, messageTo(id, 'mine'))
        const unknown = { ok: false, message: 'Unknown message' }
        const heard = record(alice.socket, 'messageDeleted')

        expect(await ask(bob.socket, 'deleteMessage', { id: hers.id })).toEqual(unknown)
        expect(await ask(carol.socket, 'deleteMessage', { id: hers.id })).toEqual(unknown)
        expect(await ask(alice.socket, 'deleteMessage', { id: created.id })).toEqual(unknown)
        expect(await ask(alice.socket, 'deleteMessage', { id: 'f'.repeat(24) })).toEqual(unknown)
        expect(await ask(alice.socket, 'deleteMessage', { id: { $ne: null } })).toEqual(unknown)
        expect(await ask(alice.socket, 'deleteMessage', {})).toEqual(unknown)
        await settle()
        expect(heard).toEqual([])
        expect((await Message.findById(hers.id).lean()).text).toBe('mine')

        expect(await ask(alice.socket, 'deleteMessage', { id: hers.id })).toEqual({ ok: true })
        expect(await ask(alice.socket, 'deleteMessage', { id: hers.id })).toEqual(unknown)

        // Someone who has left a group has no say over what they said in it.
        const bobs = await send(bob.socket, messageTo(id, 'from bob'))
        await ask(bob.socket, 'leaveGroup', { conversationId: id })
        expect(await ask(bob.socket, 'deleteMessage', { id: bobs.id })).toEqual(unknown)
    })

    it('is not told to someone who joined after the message', async () => {
        const alice = await account('alice')
        const bob = await guest('bob')
        const carol = await guest('carol')
        const { conversationId: id } = await ask(alice.socket, 'createGroup', { name: 'Trip', userIds: [bob.userId] })
        const early = await send(alice.socket, messageTo(id, 'before carol'))
        await ask(alice.socket, 'addMembers', { conversationId: id, userIds: [carol.userId] })
        await settle()

        const heard = record(carol.socket, 'messageDeleted')
        await ask(alice.socket, 'deleteMessage', { id: early.id })
        await settle()
        expect(heard).toEqual([])
    })
})

describe('how full storage is', () => {
    it('is something an administrator can see, and nobody else', async () => {
        await app.stop()
        await start({ adminUsernames: ['owner'], bootstrapCode: 'the-code', uploadMaxTotalMb: 9000 })
        const owner = await account('owner', { bootstrapCode: 'the-code' })
        const alice = await account('alice')
        const bob = await guest('bob')
        const fileId = await upload(alice, dm(alice, bob))
        await sendWith(alice, dm(alice, bob), [fileId])
        await reserve(alice, dm(alice, bob), photo({ size: 1000 }))

        // What is stored, and what is on its way.
        expect(await ask(owner.socket, 'getStorageUsage')).toEqual({ ok: true, usedBytes: 3048, maxBytes: 9000 * MB, files: 1 })
        expect(await ask(alice.socket, 'getStorageUsage')).toEqual({ ok: false, message: 'Only an administrator can see that' })
        expect(await ask(bob.socket, 'getStorageUsage')).toEqual({ ok: false, message: 'Only an administrator can see that' })
    })
})

describe('what a deployment says about its storage', () => {
    const warnings = () => {
        const said = []
        return { said, warn: message => said.push(message) }
    }

    it('is off unless a place is named, and fully described', () => {
        expect(settingsFromEnv({})).not.toHaveProperty('fileStorage')
        expect(settingsFromEnv({ FILE_STORAGE: 'local', FILE_STORAGE_DIR: '/data/files' })).toMatchObject({ fileStorage: 'local', localStorageDir: '/data/files' })

        const s3 = { FILE_STORAGE: 's3', S3_ENDPOINT: 'https://account.r2.example', S3_BUCKET: 'chat', S3_ACCESS_KEY_ID: 'key-id', S3_SECRET_ACCESS_KEY: 'secret' }
        expect(settingsFromEnv(s3)).toMatchObject({
            fileStorage: 's3',
            s3: { endpoint: 'https://account.r2.example', region: 'auto', bucket: 'chat', accessKeyId: 'key-id', secretAccessKey: 'secret' },
        })

        // Half a description, or a name nobody knows: off, and said so — without the values.
        for (const env of [{ ...s3, S3_SECRET_ACCESS_KEY: '' }, { ...s3, S3_BUCKET: undefined }, { FILE_STORAGE: 'dropbox' }]) {
            const { said, warn } = warnings()
            expect(settingsFromEnv(env, warn)).not.toHaveProperty('fileStorage')
            expect(said).toHaveLength(1)
            expect(said[0]).toContain('file sharing is off')
            expect(said[0]).not.toMatch(/key-id|secret\b|r2\.example/)
        }
    })

    it('reads its limits in megabytes, and keeps the default for one it cannot read', () => {
        expect(settingsFromEnv({
            UPLOAD_MAX_FILE_MB: '50', UPLOAD_MAX_USER_MB_PER_DAY: '2000', UPLOAD_MAX_ADDRESS_MB_PER_DAY: '0', UPLOAD_MAX_TOTAL_MB: '9000',
        })).toMatchObject({ uploadMaxFileMb: 50, uploadMaxUserMbPerDay: 2000, uploadMaxAddressMbPerDay: 0, uploadMaxTotalMb: 9000 })

        const { said, warn } = warnings()
        const settings = settingsFromEnv({ UPLOAD_MAX_FILE_MB: 'lots', UPLOAD_MAX_TOTAL_MB: '0', UPLOAD_MAX_USER_MB_PER_DAY: '-5' }, warn)
        expect(settings).not.toHaveProperty('uploadMaxFileMb')
        expect(settings).not.toHaveProperty('uploadMaxTotalMb')
        expect(settings).not.toHaveProperty('uploadMaxUserMbPerDay')
        expect(said).toHaveLength(3)
    })
})

describe('what is signed for a bucket', () => {
    const storage = createS3Storage({
        endpoint: 'https://account.r2.example', bucket: 'chat', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-real-secret',
    })
    const key = 'files/3f0e6c1a-0000-4000-8000-000000000001'

    it('an upload: that key, that type, that many bytes, for fifteen minutes — and nothing the browser cannot send', async () => {
        const { url, headers } = await storage.presignUpload({ key, type: 'image/png', size: 2048 })
        const signed = new URL(url)
        expect(signed.origin + signed.pathname).toBe(`https://account.r2.example/chat/${key}`)
        expect(signed.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
        expect(signed.searchParams.get('X-Amz-Expires')).toBe('900')
        expect(headers).toEqual({ 'Content-Type': 'image/png' })
        // No checksum the browser would have to work out, and no secret in the address.
        expect([...signed.searchParams.keys()].some(name => /checksum/i.test(name))).toBe(false)
        expect(url).not.toContain('not-a-real-secret')
    })

    it('a download: for five minutes, with what the browser is to do with it signed into the address', async () => {
        const inline = new URL(await storage.presignDownload({ key, name: 'holiday.png', type: 'image/png', inline: true }))
        expect(inline.pathname).toBe(`/chat/${key}`)
        expect(inline.searchParams.get('X-Amz-Expires')).toBe('300')
        expect(inline.searchParams.get('response-content-type')).toBe('image/png')
        expect(inline.searchParams.get('response-content-disposition')).toMatch(/^inline; filename="holiday\.png"/)

        const download = new URL(await storage.presignDownload({ key, name: 'page.html', type: 'text/html', inline: false }))
        expect(download.searchParams.get('response-content-disposition')).toMatch(/^attachment; /)
    })
})

describe('naming a file to a browser', () => {
    it('never lets a name end the header, and keeps names that are not plain letters', () => {
        expect(contentDisposition('report.pdf', false)).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`)
        expect(contentDisposition('a"b\\c.txt', true)).toBe(`inline; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`)
        expect(contentDisposition('año (1).png', false)).toBe(`attachment; filename="a_o (1).png"; filename*=UTF-8''a%C3%B1o%20%281%29.png`)
    })

    it('shows in the page only pictures, sound, video and PDF — never SVG or HTML', () => {
        for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm', 'audio/mpeg', 'application/pdf']) {
            expect(isInlineType(type)).toBe(true)
        }
        for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/javascript', 'application/octet-stream', 'text/plain']) {
            expect(isInlineType(type)).toBe(false)
        }
    })
})
