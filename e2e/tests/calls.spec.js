import { expect, test } from '@playwright/test'
import { bubbles, chat, guests, person } from './helpers.js'

// Calls, with Chromium's made-up camera and microphone (see playwright.config.js): two
// real browsers really connect to each other, on this machine.

// One call at a time: two browsers encoding picture and sound for each other are heavy,
// and several calls at once slow every other spec running beside them.
test.describe.configure({ mode: 'default' })

const callView = page => page.getByRole('region', { name: /^Call with / })
const incoming = (page, from) => page.getByRole('dialog', { name: `${from} is calling` })

/** What the other person's device is sending, as this page receives it. */
const received = page =>
    page.locator('video[data-stream=remote]').evaluate(video => ({
        width: video.videoWidth,
        height: video.videoHeight,
        playing: video.currentTime > 0 && !video.paused,
        sound: video.srcObject?.getAudioTracks().some(track => track.readyState === 'live') === true,
    }))

test('a video call: each sees and hears the other, and the conversation says how long it lasted', async ({ browser }) => {
    const [ana, ben] = await guests(browser, 'ana', 'ben')
    await person(ana.page, ben.name).click()
    await ana.page.getByRole('button', { name: 'Video call', exact: true }).click()

    // Ringing on both sides: ana sees her own call, ben is asked.
    await expect(callView(ana.page)).toContainText('Ringing…')
    await incoming(ben.page, ana.name).getByRole('button', { name: 'Accept with video' }).click()

    for (const page of [ana.page, ben.page]) {
        await expect(callView(page)).toHaveAttribute('data-call', 'active')
        await expect(callView(page).getByRole('timer')).toHaveText(/^0:0\d$/)
        // Picture and sound really arrive from the other browser.
        await expect.poll(() => received(page)).toMatchObject({ playing: true, sound: true })
        const { width, height } = await received(page)
        expect(width).toBeGreaterThan(0)
        expect(height).toBeGreaterThan(0)
        // And the user's own picture is in its corner.
        await expect(page.locator('video[data-stream=local]')).toBeVisible()
    }

    // Shrunk to a corner, the conversation can be written in; and brought back.
    await ana.page.getByRole('button', { name: 'Minimise the call' }).click()
    await expect(ana.page.getByRole('textbox', { name: /^Message / })).toBeVisible()
    await ana.page.getByRole('button', { name: 'Back to the call' }).click()

    // Muting is said to the user; it does not end anything.
    await ben.page.getByRole('button', { name: 'Mute the microphone' }).click()
    await expect(ben.page.getByRole('button', { name: 'Unmute the microphone' })).toBeVisible()

    // A camera turned off is the person's avatar to the other, not a black picture; and back.
    const benToAna = ana.page.locator('video[data-stream=remote]')
    await ben.page.getByRole('button', { name: 'Turn the camera off' }).click()
    await expect(benToAna).toBeHidden()
    await ben.page.getByRole('button', { name: 'Turn the camera on' }).click()
    await expect(benToAna).toBeVisible()

    // Another microphone can be spoken through, there and then; the call goes on.
    await ana.page.getByRole('button', { name: 'Microphone, camera and speaker' }).click()
    const microphone = ana.page.getByRole('combobox', { name: 'Microphone' })
    await expect(ana.page.getByRole('combobox', { name: 'Camera' })).toBeVisible()
    const names = await microphone.locator('option').allTextContents()
    expect(names.length).toBeGreaterThan(1)
    await microphone.selectOption({ label: names.at(-1) })
    await expect(microphone).toHaveValue(/.+/)
    await ana.page.keyboard.press('Escape')
    await expect.poll(() => received(ben.page)).toMatchObject({ playing: true, sound: true })
    await expect(callView(ana.page)).toHaveAttribute('data-call', 'active')

    await ana.page.getByRole('button', { name: 'Hang up' }).click()
    await expect(callView(ana.page)).toBeHidden()
    await expect(callView(ben.page)).toBeHidden()
    await expect(ben.page.getByRole('alert').filter({ hasText: 'Call ended' })).toBeVisible()

    // Both find it in the conversation.
    await chat(ben.page, ana.name).click()
    for (const page of [ana.page, ben.page]) await expect(bubbles(page)).toHaveText([/^Video call · \d+ s$/])
    expect([...ana.page.consoleErrors, ...ben.page.consoleErrors]).toEqual([])
})

test('a screen shared in a voice call is seen by the other person, whoever shares, and gone when it stops', async ({ browser }) => {
    const [ana, ben] = await guests(browser, 'ana', 'ben')
    await person(ana.page, ben.name).click()
    await ana.page.getByRole('button', { name: 'Voice call', exact: true }).click()
    await incoming(ben.page, ana.name).getByRole('button', { name: 'Accept' }).click()
    for (const page of [ana.page, ben.page]) await expect(callView(page)).toHaveAttribute('data-call', 'active')

    // First the one who called, then the one who was called: either may add a picture to the call.
    for (const [sharer, watcher] of [[ana, ben], [ben, ana]]) {
        const shown = watcher.page.locator('video[data-stream=remote]')
        await expect(shown).toBeHidden()

        await sharer.page.getByRole('button', { name: 'Share your screen' }).click()
        await expect(callView(sharer.page)).toContainText('You are sharing your screen')
        await expect(shown).toBeVisible()
        await expect.poll(async () => (await received(watcher.page)).width).toBeGreaterThan(0)

        await sharer.page.getByRole('button', { name: 'Stop sharing your screen' }).click()
        await expect(callView(sharer.page)).not.toContainText('You are sharing your screen')
        await expect(shown).toBeHidden()
    }

    // The voices were there throughout.
    for (const page of [ana.page, ben.page]) await expect.poll(() => received(page)).toMatchObject({ sound: true })
    await ben.page.getByRole('button', { name: 'Hang up' }).click()
    await expect(callView(ana.page)).toBeHidden()
    expect([...ana.page.consoleErrors, ...ben.page.consoleErrors]).toEqual([])
})

test('a call that is declined: the caller is told, and each reads it their own way', async ({ browser }) => {
    const [ana, ben] = await guests(browser, 'ana', 'ben')
    await person(ana.page, ben.name).click()
    await ana.page.getByRole('button', { name: 'Voice call', exact: true }).click()

    await expect(incoming(ben.page, ana.name)).toContainText('Voice call')
    await incoming(ben.page, ana.name).getByRole('button', { name: 'Decline' }).click()

    await expect(incoming(ben.page, ana.name)).toBeHidden()
    await expect(callView(ana.page)).toBeHidden()
    await expect(ana.page.getByRole('alert').filter({ hasText: `${ben.name} declined the call` })).toBeVisible()
    await expect(bubbles(ana.page)).toHaveText(['Voice call · declined'])
    await chat(ben.page, ana.name).click()
    await expect(bubbles(ben.page)).toHaveText(['You declined a voice call'])
    // Having declined, they can be called again — and can call back.
    await expect(ben.page.getByRole('button', { name: 'Voice call', exact: true })).toBeEnabled()
    expect([...ana.page.consoleErrors, ...ben.page.consoleErrors]).toEqual([])
})

test('a call nobody answers is missed, and waits for them as something unread', async ({ browser }) => {
    // (It rings for half a minute.)
    test.setTimeout(75_000)
    const [ana, ben] = await guests(browser, 'ana', 'ben')
    // (Every note the page plays is counted, by its pitch.)
    for (const { page } of [ana, ben]) {
        await page.evaluate(() => {
            const start = OscillatorNode.prototype.start
            window.notesPlayed = []
            OscillatorNode.prototype.start = function (...when) {
                window.notesPlayed.push(this.frequency.value)
                return start.apply(this, when)
            }
        })
    }
    const notes = page => page.evaluate(() => window.notesPlayed)
    await person(ana.page, ben.name).click()
    await ana.page.getByRole('button', { name: 'Voice call', exact: true }).click()
    await expect(incoming(ben.page, ana.name)).toBeVisible()
    // It is heard at both ends: a ringtone where it rings, a quieter tone where it was made.
    await expect.poll(() => notes(ben.page)).toEqual(expect.arrayContaining([660, 880]))
    await expect.poll(() => notes(ana.page)).toContain(440)
    // While it rings, the tab says so to someone looking elsewhere.
    await expect.poll(() => ben.page.title()).toBe(`${ana.name} is calling…`)

    await expect(ana.page.getByRole('alert').filter({ hasText: `${ben.name} did not answer` })).toBeVisible({ timeout: 40_000 })

    await expect(incoming(ben.page, ana.name)).toBeHidden()
    await expect(chat(ben.page, ana.name)).toContainText('Missed voice call')
    await expect(chat(ben.page, ana.name)).toContainText('1 unread')
    await expect(bubbles(ana.page)).toHaveText(['Voice call · no answer'])
    await expect.poll(() => ben.page.title()).not.toContain('is calling')
    // And is heard no more once it is over.
    const [heardByAna, heardByBen] = [(await notes(ana.page)).length, (await notes(ben.page)).length]
    await ana.page.waitForTimeout(3500)
    expect([(await notes(ana.page)).length, (await notes(ben.page)).length]).toEqual([heardByAna, heardByBen])
    expect([...ana.page.consoleErrors, ...ben.page.consoleErrors]).toEqual([])
})

test('someone who is offline or not to be disturbed cannot be called, and the button says why', async ({ browser }) => {
    const [ana, ben] = await guests(browser, 'ana', 'ben')
    await person(ana.page, ben.name).click()
    await expect(ana.page.getByRole('button', { name: 'Video call', exact: true })).toBeEnabled()

    await ben.page.getByRole('button', { name: `Account menu for ${ben.name}` }).click()
    await ben.page.getByRole('menuitemradio', { name: /^Do not disturb/ }).click()
    await expect(ana.page.getByRole('button', { name: `Video call — ${ben.name} has asked not to be disturbed` })).toBeDisabled()

    await ben.page.close()
    await expect(ana.page.getByRole('button', { name: `Voice call — ${ben.name} is offline` })).toBeDisabled()
    expect(ana.page.consoleErrors).toEqual([])
})

test('leaving the page hangs up: the other person is told at once, not left on a dead call', async ({ browser }) => {
    const [ana, ben] = await guests(browser, 'ana', 'ben')
    await person(ana.page, ben.name).click()
    await ana.page.getByRole('button', { name: 'Voice call', exact: true }).click()
    await incoming(ben.page, ana.name).getByRole('button', { name: 'Accept' }).click()
    await expect(callView(ana.page)).toHaveAttribute('data-call', 'active')
    // A voice call: no picture, the other person's avatar instead — and their voice.
    await expect.poll(() => received(ana.page)).toMatchObject({ width: 0, sound: true })

    // (A reload is a way of leaving that the browser lets the page say goodbye from.)
    await ben.page.reload()

    // Well within the time a merely lost connection would be waited for.
    await expect(ana.page.getByRole('alert').filter({ hasText: 'Call ended' })).toBeVisible({ timeout: 5000 })
    await expect(callView(ana.page)).toBeHidden()
    await expect(callView(ben.page)).toBeHidden()
    await expect(bubbles(ana.page)).toHaveText([/^Voice call · \d+ s$/])
    expect(ana.page.consoleErrors).toEqual([])
})
