import { expect, test } from '@playwright/test'
import {
    attach, bubbles, chat, createAccount, draftFiles, filePicker, joinAsGuest, jpegFile, log, openApp, pdfFile, person, pngFile,
    signedInAs, unique, webmFile,
} from './helpers.js'

// Files, against real storage (a folder, served by the server over signed addresses):
// what one browser uploads, the other really fetches and shows.

/** Ana, with an account, and Ben, a guest — Ana has Ben's conversation open. */
const anaAndBen = async browser => {
    const [anaName, benName] = [unique('ana'), unique('ben')]
    const ana = await openApp(browser)
    await createAccount(ana, anaName)
    const ben = await openApp(browser)
    await joinAsGuest(ben, benName)
    await signedInAs(ben, benName)
    await person(ana, benName).click()
    return { ana, ben, anaName, benName }
}
const sendButton = page => page.getByRole('button', { name: 'Send', exact: true })
/** Whether a picture has really loaded: it has a size of its own. */
const loaded = image => image.evaluate(element => element.complete && element.naturalWidth > 0)

test('a picture, a video and a PDF: sent from one browser, previewed in the other, opened and downloaded', async ({ browser }) => {
    const { ana, ben, anaName } = await anaAndBen(browser)

    // A picture with a few words.
    await attach(ana, pngFile('holiday.png', 320, 200))
    await ana.getByRole('textbox', { name: /^Message / }).fill('from the trip')
    await sendButton(ana).click()
    await expect(draftFiles(ana)).toHaveCount(0)
    const sent = log(ana).getByRole('img', { name: 'holiday.png' })
    await expect.poll(() => loaded(sent)).toBe(true)

    // Ben — a guest — is shown it, fetched from storage with an address of his own.
    await chat(ben, anaName).click()
    const received = log(ben).getByRole('img', { name: 'holiday.png' })
    await expect.poll(() => loaded(received)).toBe(true)
    expect(await received.evaluate(element => [element.naturalWidth, element.naturalHeight])).toEqual([320, 200])
    await expect(bubbles(ben)).toContainText(['from the trip'])

    // A video plays where it is: enough of it is loaded to know its size.
    await attach(ana, await webmFile(ana, 'clip.webm'))
    await sendButton(ana).click()
    const video = log(ben).locator('video')
    await expect.poll(() => video.evaluate(element => element.readyState >= 1 && element.videoWidth)).toBe(64)

    // A PDF is a card: it opens over the conversation, and can be downloaded.
    await attach(ana, pdfFile('notes.pdf'))
    await sendButton(ana).click()
    await ben.getByRole('button', { name: 'Open notes.pdf' }).click()
    const viewer = ben.getByRole('dialog', { name: 'notes.pdf' })
    await expect(viewer.locator('iframe')).toHaveAttribute('src', /\/files\//)
    const download = ben.waitForEvent('download')
    await viewer.getByRole('button', { name: 'Download' }).click()
    expect((await download).suggestedFilename()).toBe('notes.pdf')
    await ben.keyboard.press('Escape')
    await expect(viewer).toBeHidden()

    // The picture opens full size, and the arrow keys step on to the video.
    await received.click()
    await expect(ben.getByRole('dialog', { name: 'holiday.png' })).toContainText('1 of 2')
    await expect.poll(() => loaded(ben.getByRole('dialog').getByRole('img', { name: 'holiday.png' }))).toBe(true)
    await ben.keyboard.press('ArrowRight')
    await expect(ben.getByRole('dialog', { name: 'clip.webm' })).toContainText('2 of 2')
    await ben.keyboard.press('Escape')

    // A very wide picture is sent smaller — measured and given a small blurred preview
    // in Ana's browser first, so that Ben's bubble has its shape before the picture loads.
    await attach(ana, await jpegFile(ana, 'panorama.jpg', 3200, 200))
    await expect(draftFiles(ana)).toContainText(['made smaller'])
    await expect(ana.getByRole('checkbox', { name: 'Send original' })).not.toBeChecked()
    await sendButton(ana).click()
    const panorama = log(ben).getByRole('img', { name: 'panorama.jpg' })
    await expect.poll(() => loaded(panorama)).toBe(true)
    expect(await panorama.evaluate(element => element.naturalWidth)).toBe(2560)
    expect(await log(ben).getByRole('button', { name: 'View panorama.jpg' }).evaluate(element => element.style.backgroundImage))
        .toMatch(/^url\("data:image\/(webp|jpeg);base64,/)

    // Everything is still there after a reload: nothing was only held in the page.
    await ben.reload()
    await chat(ben, anaName).click()
    // (The conversation opens at its end: a picture further up is fetched when it is scrolled near.)
    await log(ben).getByRole('button', { name: 'View holiday.png' }).scrollIntoViewIfNeeded()
    await expect.poll(() => loaded(log(ben).getByRole('img', { name: 'holiday.png' }))).toBe(true)
    await expect(chat(ben, anaName)).toContainText('1 file')

    // Ana takes the picture back: it is gone for both, and the file with it.
    await log(ana).getByRole('listitem').filter({ has: ana.getByRole('button', { name: 'View holiday.png' }) }).getByRole('button', { name: 'Delete this message' }).click()
    await ana.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(log(ben).getByText(`${anaName} deleted a message`)).toBeVisible()
    await expect(log(ben).getByRole('img', { name: 'holiday.png' })).toHaveCount(0)
    await expect(log(ana).getByText('You deleted a message')).toBeVisible()
    expect([...ana.consoleErrors, ...ben.consoleErrors]).toEqual([])
})

test('a file over the size limit is refused before it is uploaded, and a guest cannot attach at all', async ({ browser }) => {
    const { ana, ben, anaName } = await anaAndBen(browser)

    // This deployment takes files up to 1 MB.
    await filePicker(ana).setInputFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 * 1024 + 1) })
    await expect(draftFiles(ana)).toHaveText([/huge\.bin.*Too large — a file can be at most 1\.0 MB/])
    await expect(sendButton(ana)).toBeDisabled()
    // Removed, and a file that fits goes through.
    await ana.getByRole('button', { name: 'Remove huge.bin' }).click()
    await attach(ana, { name: 'small.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2000, 7) })
    await sendButton(ana).click()

    // Ben is shown it as something to download — and what he downloads is what was sent.
    await chat(ben, anaName).click()
    const download = ben.waitForEvent('download')
    await ben.getByRole('button', { name: 'Download small.bin' }).click()
    const saved = await download
    expect(saved.suggestedFilename()).toBe('small.bin')
    const stream = await saved.createReadStream()
    const chunks = []
    for await (const piece of stream) chunks.push(piece)
    expect(Buffer.concat(chunks).equals(Buffer.alloc(2000, 7))).toBe(true)

    // Sending files is for accounts.
    await expect(ben.getByRole('button', { name: 'Create an account to send files' })).toBeDisabled()
})
