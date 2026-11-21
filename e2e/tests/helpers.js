import { randomBytes } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { expect } from '@playwright/test'

// What a person does in the app, in the words the tests use. Everything is found the way
// a user (or a screen reader) finds it: by role, label and visible text.

export const PASSWORD = 'correct horse battery staple'

/** A name nobody else in this run is using: tests share a server, never a user. */
export const unique = name => `${name}-${randomBytes(3).toString('hex')}`

// Nothing the app does should log an error. Each page collects what it logs, for the
// test to check at the end.
const watch = page => {
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text())
    })
    page.consoleErrors = errors
    return page
}

// Every browser gets an address of its own, as the server sees it. The server limits new
// names and sign-ups per client address, and all of these browsers are really one
// machine: without this the whole suite would share one visitor's allowance. (The stack
// runs with one trusted proxy, which this header stands in for — see profiles.js.)
// Random rather than counted: the tests run in several worker processes at once. The
// range is one reserved for testing, so it can never be anybody's real address.
const nextAddress = () => `198.18.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 254)}`

/**
 * One person at one browser: a fresh context (its own storage, like a separate browser)
 * with the app open. `options` are Playwright context options (a phone-sized viewport…).
 */
export const openApp = async (browser, options = {}, path = '/') => {
    const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': nextAddress() }, ...options })
    return openTab(context, path)
}

/** Another tab of the same browser: shared storage, as tabs have. */
export const openTab = async (context, path = '/') => {
    const page = watch(await context.newPage())
    await page.goto(path)
    return page
}

/** The signed-in user's own entry at the top of the sidebar, which opens their menu. */
export const menuButton = (page, username) => page.getByRole('button', { name: `Account menu for ${username}` })

export const signedInAs = (page, username) => expect(menuButton(page, username)).toBeVisible()

export const joinAsGuest = async (page, username) => {
    await page.getByLabel('Username').fill(username)
    await page.getByRole('button', { name: 'Join' }).click()
}

/** Two guests, each in their own browser, both signed in. */
export const twoGuests = async browser => {
    const [ana, ben] = await guests(browser, 'ana', 'ben')
    return { ana: ana.page, ben: ben.page, anaName: ana.name, benName: ben.name }
}

/** Fills in the sign-up form that is on screen and submits it. */
export const fillSignUp = async (page, username, password = PASSWORD) => {
    await page.getByLabel('Username').fill(username)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Create account' }).click()
}

/** Signs up from the entry screen; resolves with the recovery code shown. */
export const createAccount = async (page, username, password = PASSWORD) => {
    await page.getByRole('tab', { name: 'Create account' }).click()
    await fillSignUp(page, username, password)
    const code = await page.getByRole('status', { name: 'Recovery code' }).textContent()
    await page.getByRole('button', { name: 'I’ve saved it' }).click()
    await signedInAs(page, username)
    return code
}

export const signIn = async (page, username, password = PASSWORD) => {
    // Where only signing in is offered there are no tabs to choose from.
    const tab = page.getByRole('tab', { name: 'Sign in' })
    if (await tab.isVisible()) await tab.click()
    await page.getByLabel('Username').fill(username)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
}

export const accountMenu = async (page, username, item) => {
    await menuButton(page, username).click()
    await page.getByRole('menuitem', { name: item }).click()
}

/** Picks one of the statuses in the account menu, by the start of its label. */
export const chooseStatus = async (page, username, status) => {
    await menuButton(page, username).click()
    await page.getByRole('menuitemradio', { name: new RegExp(`^${status}`) }).click()
}

const entry = (list, name) => list.getByRole('button').filter({ has: list.page().getByText(name, { exact: true }) })

/** The People section: "People online", or "People" where every account is listed. */
export const people = page => page.getByRole('navigation', { name: /^People/ })
export const chats = page => page.getByRole('navigation', { name: 'Chats' })
export const person = (page, name) => entry(people(page), name)
export const chat = (page, name) => entry(chats(page), name)

export const composer = page => page.getByRole('textbox', { name: /^Message / })

export const send = async (page, text) => {
    await composer(page).fill(text)
    await composer(page).press('Enter')
}

/** A message of one's own that the server has saved, however far it has got since. */
export const SAVED = /Sent|Delivered|Seen/
/** The tick on one's own message: 'sent', 'delivered' or 'seen'. */
export const tick = (page, text) => messageRow(page, text).locator('[data-tick]')

/** The open conversation. */
export const log = page => page.getByRole('log')
/** Every message bubble in the open conversation, in order — and, in a group, each line about the group. */
export const bubbles = page => log(page).locator('[data-bubble]')

/** Several guests, each in their own browser, all signed in: `{ page, name }` each, in the order asked for. */
export const guests = async (browser, ...names) => {
    const joined = []
    for (const name of names) {
        const page = await openApp(browser)
        const username = unique(name)
        await joinAsGuest(page, username)
        joined.push({ page, name: username })
    }
    for (const { page, name } of joined) await signedInAs(page, name)
    return joined
}

/** Ticks the people named in the picker that is on screen. */
export const choosePeople = async (scope, ...names) => {
    for (const name of names) await scope.getByRole('checkbox', { name: new RegExp(name) }).click()
}

/** Makes a group from the sidebar; it is open when this resolves. */
export const createGroup = async (page, name, ...memberNames) => {
    await page.getByRole('button', { name: 'New group' }).click()
    const dialog = page.getByRole('dialog', { name: 'New group' })
    await dialog.getByLabel('Group name').fill(name)
    await choosePeople(dialog, ...memberNames)
    await dialog.getByRole('button', { name: 'Create group' }).click()
    await expect(composer(page)).toBeVisible()
}

/** Opens the details of the group that is open, and resolves with the panel. */
export const groupDetails = async (page, name) => {
    await page.getByRole('button', { name: 'Group details' }).click()
    const panel = page.getByRole('dialog', { name })
    await expect(panel).toBeVisible()
    return panel
}
/** The row (author, text, status) of the message with exactly this text. */
export const messageRow = (page, text) => log(page).getByRole('listitem').filter({ has: page.getByText(text, { exact: true }) })


// ---------- files

/** The (hidden) control behind the attach button. */
export const filePicker = page => page.getByLabel('Choose files to send')
/** The chips of the files chosen for the message being written. */
export const draftFiles = page => page.getByRole('list', { name: 'Files to send' }).getByRole('listitem')

/** Attaches files and waits until each has been uploaded. `files`: `{ name, mimeType, buffer }`. */
export const attach = async (page, ...files) => {
    await filePicker(page).setInputFiles(files)
    await expect(draftFiles(page)).toHaveCount(files.length)
    for (const chip of await draftFiles(page).all()) await expect(chip).toHaveAttribute('data-status', 'ready')
}

const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const check = Buffer.alloc(4)
    check.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, check])
}

/** A real PNG of one colour, `width` × `height`. */
export const pngFile = (name, width = 64, height = 48, colour = [40, 120, 200]) => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header.set([8, 2, 0, 0, 0], 8)   // 8 bits a channel, RGB
    const row = () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from(colour))])
    const buffer = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, row)))),
        chunk('IEND', Buffer.alloc(0)),
    ])
    return { name, mimeType: 'image/png', buffer }
}

/** A one-page PDF with a line of text. */
export const pdfFile = name => {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        '<< /Length 44 >>\nstream\nBT /F1 18 Tf 40 100 Td (Hello from a PDF) Tj ET\nendstream',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    let body = '%PDF-1.4\n'
    const offsets = objects.map((object, index) => {
        const at = body.length
        body += `${index + 1} 0 obj\n${object}\nendobj\n`
        return at
    })
    const xref = body.length
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const at of offsets) body += `${String(at).padStart(10, '0')} 00000 n \n`
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return { name, mimeType: 'application/pdf', buffer: Buffer.from(body, 'latin1') }
}

/** A real JPEG at full quality, like a photo: stripes and noise, drawn and encoded in the browser. */
export const jpegFile = async (page, name, width, height) => {
    const bytes = await page.evaluate(async ([w, h]) => {
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const context = canvas.getContext('2d')
        for (let x = 0; x < w; x += 4) {
            context.fillStyle = `hsl(${Math.random() * 360} 70% ${30 + Math.random() * 40}%)`
            context.fillRect(x, 0, 4, h)
        }
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 1))
        return [...new Uint8Array(await blob.arrayBuffer())]
    }, [width, height])
    return { name, mimeType: 'image/jpeg', buffer: Buffer.from(bytes) }
}

/** A short real video, recorded in the browser from a canvas (so that no binary file is kept in the repository). */
export const webmFile = async (page, name) => {
    const bytes = await page.evaluate(async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 48
        const context = canvas.getContext('2d')
        const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' })
        const chunks = []
        recorder.ondataavailable = event => chunks.push(event.data)
        const stopped = new Promise(resolve => { recorder.onstop = resolve })
        recorder.start()
        for (let frame = 0; frame < 12; frame += 1) {
            context.fillStyle = `hsl(${frame * 30} 80% 50%)`
            context.fillRect(0, 0, 64, 48)
            await new Promise(resolve => setTimeout(resolve, 60))
        }
        recorder.stop()
        await stopped
        return [...new Uint8Array(await new Blob(chunks).arrayBuffer())]
    })
    return { name, mimeType: 'video/webm', buffer: Buffer.from(bytes) }
}
