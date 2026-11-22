import { expect, test } from '@playwright/test'
import { bubbles, chat, guests, person } from './helpers.js'

// Calls, with Chromium's made-up camera and microphone (see playwright.config.js): two
// real browsers really connect to each other, on this machine.

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

    await ana.page.getByRole('button', { name: 'Hang up' }).click()
    await expect(callView(ana.page)).toBeHidden()
    await expect(callView(ben.page)).toBeHidden()
    await expect(ben.page.getByRole('alert').filter({ hasText: 'Call ended' })).toBeVisible()

    // Both find it in the conversation.
    await chat(ben.page, ana.name).click()
    for (const page of [ana.page, ben.page]) await expect(bubbles(page)).toHaveText([/^Video call · \d+ s$/])
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
    await person(ana.page, ben.name).click()
    await ana.page.getByRole('button', { name: 'Voice call', exact: true }).click()
    await expect(incoming(ben.page, ana.name)).toBeVisible()
    // While it rings, the tab says so to someone looking elsewhere.
    await expect.poll(() => ben.page.title()).toBe(`${ana.name} is calling…`)

    await expect(ana.page.getByRole('alert').filter({ hasText: `${ben.name} did not answer` })).toBeVisible({ timeout: 40_000 })

    await expect(incoming(ben.page, ana.name)).toBeHidden()
    await expect(chat(ben.page, ana.name)).toContainText('Missed voice call')
    await expect(chat(ben.page, ana.name)).toContainText('1 unread')
    await expect(bubbles(ana.page)).toHaveText(['Voice call · no answer'])
    await expect.poll(() => ben.page.title()).not.toContain('is calling')
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
