import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Router } from 'express'
import createError from 'http-errors'
import { DOWNLOAD_URL_SECONDS, UPLOAD_URL_SECONDS, contentDisposition } from './index.js'

// Files in a folder on this machine, for development and tests: no account, no network.
// It behaves like the real thing as far as a browser can tell — the bytes travel over
// URLs that are signed, expire, and allow one kind of request each — but they are served by this
// server (`router`), which a real deployment must never do with its ephemeral disk.

// A key is `files/<uuid>`: it names one file directly under the folder, and nothing else.
const KEY = /^files\/[0-9a-f-]{36}$/

export const createLocalStorage = ({ directory }) => {
    const root = path.resolve(directory)
    // URLs signed by one run of the server are of no use to the next: they last minutes.
    const secret = randomBytes(32)

    const pathOf = key => {
        if (!KEY.test(key)) throw new TypeError('not a storage key')
        return path.join(root, key.slice('files/'.length))
    }

    const sign = body => createHmac('sha256', secret).update(body).digest('base64url')
    const tokenFor = grant => {
        const body = Buffer.from(JSON.stringify(grant)).toString('base64url')
        return `${body}.${sign(body)}`
    }
    /** What a token allows, or null if it was not signed here or has expired. */
    const grantOf = token => {
        const [body, signature, ...rest] = String(token).split('.')
        if (!body || !signature || rest.length > 0) return null
        const expected = Buffer.from(sign(body))
        const given = Buffer.from(signature)
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
        try {
            const grant = JSON.parse(Buffer.from(body, 'base64url').toString())
            return grant.exp > Date.now() ? grant : null
        } catch {
            return null
        }
    }
    const urlFor = (baseUrl, grant, seconds) =>
        `${baseUrl}/files/${tokenFor({ ...grant, exp: Date.now() + seconds * 1000 })}`

    const router = Router()

    // An upload: exactly the declared number of bytes, declared as the signed type.
    router.put('/files/:token', async (req, res, next) => {
        const grant = grantOf(req.params.token)
        if (grant?.op !== 'put') return next(createError(403))
        if (req.headers['content-type'] !== grant.type || Number(req.headers['content-length']) !== grant.size) {
            return next(createError(400, 'Not the file this address was given for'))
        }
        const target = pathOf(grant.key)
        try {
            await mkdir(root, { recursive: true })
            await pipeline(req, createWriteStream(target))
            // (The connection's own framing holds a body to its Content-Length; this is the proof.)
            if ((await stat(target)).size !== grant.size) throw createError(400, 'Not the file this address was given for')
            res.status(200).end()
        } catch (error) {
            await rm(target, { force: true }).catch(() => {})
            next(error.status ? error : createError(500))
        }
    })

    // A download, whole or in part: `Range` is what lets a video be sought.
    router.get('/files/:token', async (req, res, next) => {
        const grant = grantOf(req.params.token)
        if (grant?.op !== 'get') return next(createError(403))
        const size = await stat(pathOf(grant.key)).then(found => found.size, () => null)
        if (size === null) return next(createError(404))

        // (Set as it is: Express would add a charset of its own choosing to a text type.)
        res.setHeader('Content-Type', grant.type)
        res.set({
            'Content-Disposition': contentDisposition(grant.name, grant.inline),
            // Whatever the bytes look like, they are what the header says and nothing more.
            'X-Content-Type-Options': 'nosniff',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=300',
        })
        const range = rangeOf(req.headers.range, size)
        if (range === 'unsatisfiable') {
            res.set('Content-Range', `bytes */${size}`).status(416).end()
            return
        }
        const { start, end } = range ?? { start: 0, end: size - 1 }
        if (range) res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`)
        res.set('Content-Length', String(size === 0 ? 0 : end - start + 1))
        if (size === 0) return res.end()
        pipeline(createReadStream(pathOf(grant.key), { start, end }), res).catch(() => res.destroy())
    })

    return {
        router,
        presignUpload: async ({ key, type, size, baseUrl }) => ({
            url: urlFor(baseUrl, { op: 'put', key: (pathOf(key), key), type, size }, UPLOAD_URL_SECONDS),
            headers: { 'Content-Type': type },
        }),
        presignDownload: async ({ key, name, type, inline, baseUrl }) =>
            urlFor(baseUrl, { op: 'get', key: (pathOf(key), key), name, type, inline }, DOWNLOAD_URL_SECONDS),
        head: async key => stat(pathOf(key)).then(found => ({ size: found.size }), () => null),
        copy: async (from, to) => {
            try {
                await copyFile(pathOf(from), pathOf(to))
                return true
            } catch (error) {
                if (error?.code === 'ENOENT') return false
                throw error
            }
        },
        remove: async key => {
            await rm(pathOf(key), { force: true })
        },
    }
}

// One range of bytes ("bytes=0-99", "bytes=100-", "bytes=-50"). Anything else is served whole.
const rangeOf = (header, size) => {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim())
    if (!match || (match[1] === '' && match[2] === '')) return null
    if (match[1] === '') {
        const last = Number(match[2])
        if (last === 0 || size === 0) return 'unsatisfiable'
        return { start: Math.max(0, size - last), end: size - 1 }
    }
    const start = Number(match[1])
    const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
    return start >= size || start > end ? 'unsatisfiable' : { start, end }
}
