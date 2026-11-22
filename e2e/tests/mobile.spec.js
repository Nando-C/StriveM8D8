import { devices, expect, test } from './test.js'
import { bubbles, chat, chats, composer, joinAsGuest, menuButton, openApp, people, person, send, signedInAs, unique } from './helpers.js'

// The same app on a phone: the list and the conversation are separate screens.
// (Only the size and touch settings of a phone; the browser is still Chromium.)
const { viewport, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
const phone = { viewport, deviceScaleFactor, isMobile, hasTouch }

test('on a phone, the list and the conversation take turns on screen', async ({ browser }) => {
    const [anaName, benName] = [unique('ana'), unique('ben')]
    const ana = await openApp(browser, phone)
    await joinAsGuest(ana, anaName)
    await signedInAs(ana, anaName)
    const ben = await openApp(browser)
    await joinAsGuest(ben, benName)

    // The list fills the screen; there is no conversation beside it.
    await expect(people(ana)).toBeVisible()
    await expect(ana.getByRole('heading', { name: 'Your conversations' })).toBeHidden()

    await person(ana, benName).tap()
    await expect(people(ana)).toBeHidden()
    await expect(composer(ana)).toBeVisible()
    await send(ana, 'from my phone')
    await expect(bubbles(ana)).toHaveText(['from my phone'])

    await ana.getByRole('button', { name: 'Back to chats' }).tap()
    await expect(composer(ana)).toBeHidden()
    await expect(chat(ana, benName)).toContainText('You: from my phone')

    // A reply arrives while the list is showing: a badge there, then the message inside.
    await chat(ben, anaName).click()
    await send(ben, 'got it')
    await expect(chat(ana, benName)).toContainText('1 unread message')
    await chat(ana, benName).tap()
    await expect(bubbles(ana)).toHaveText(['from my phone', 'got it'])
    await expect(chats(ana)).toBeHidden()

    // Nothing is wider than the screen.
    const overflow = await ana.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    expect(ana.consoleErrors).toEqual([])
})

test('on a phone, the entry screen and the account menu fit and work', async ({ browser }) => {
    const name = unique('cal')
    const cal = await openApp(browser, phone)

    await cal.getByRole('tab', { name: 'Create account' }).tap()
    await expect(cal.getByLabel('Password')).toBeVisible()
    await cal.getByRole('tab', { name: 'Guest' }).tap()
    await joinAsGuest(cal, name)
    await signedInAs(cal, name)

    await menuButton(cal, name).tap()
    await expect(cal.getByRole('menuitem', { name: 'Create an account to keep this name' })).toBeInViewport()
    await expect(cal.getByRole('menuitem', { name: 'Leave' })).toBeInViewport()
})
