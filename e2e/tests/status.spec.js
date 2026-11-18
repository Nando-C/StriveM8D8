import { expect, test } from '@playwright/test'
import { bubbles, chat, joinAsGuest, openApp, person, send, signedInAs, unique } from './helpers.js'

const chooseStatus = async (page, username, status) => {
    await page.getByRole('button', { name: `Account menu for ${username}` }).click()
    await page.getByRole('menuitemradio', { name: new RegExp(`^${status}`) }).click()
}

test('a status and a status message are seen by the other person, and kept across a reload', async ({ browser }) => {
    const [anaName, benName] = [unique('ana'), unique('ben')]
    const ana = await openApp(browser)
    await joinAsGuest(ana, anaName)
    const ben = await openApp(browser)
    await joinAsGuest(ben, benName)
    await expect(person(ben, anaName)).toContainText('Guest · Online')

    await chooseStatus(ana, anaName, 'Do not disturb')
    await expect(person(ben, anaName)).toContainText('Guest · Do not disturb')

    await ana.getByRole('button', { name: `Account menu for ${anaName}` }).click()
    await ana.getByRole('menuitem', { name: 'Set a status message' }).click()
    const dialog = ana.getByRole('dialog', { name: 'Status message' })
    await dialog.getByLabel('Message').fill('writing, back at four')
    await dialog.getByLabel('Clear after').selectOption('4 hours')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    await expect(person(ben, anaName)).toContainText('Do not disturb — writing, back at four')
    const own = ana.getByRole('button', { name: `Account menu for ${anaName}` })
    await expect(own).toContainText('Do not disturb — writing, back at four')

    // It is the user's, not the tab's: still there after a reload, for both of them.
    await ana.reload()
    await signedInAs(ana, anaName)
    await expect(own).toContainText('Do not disturb — writing, back at four')
    await expect(person(ben, anaName)).toContainText('Do not disturb — writing, back at four')
    expect([...ana.consoleErrors, ...ben.consoleErrors]).toEqual([])
})

test('an invisible user disappears for others, is told so, and can still talk', async ({ browser }) => {
    const [anaName, benName] = [unique('ana'), unique('ben')]
    const ana = await openApp(browser)
    await joinAsGuest(ana, anaName)
    const ben = await openApp(browser)
    await joinAsGuest(ben, benName)
    await person(ben, anaName).click()
    await send(ben, 'are you there?')
    await chat(ana, benName).click()
    await expect(ben.getByRole('heading', { name: anaName }).locator('..')).toContainText('Guest · Online')

    await chooseStatus(ana, anaName, 'Invisible')

    // For Ben she has simply gone.
    await expect(person(ben, anaName)).toBeHidden()
    await expect(ben.getByRole('heading', { name: anaName }).locator('..')).toContainText('Offline')
    // She knows, and still sees him.
    await expect(ana.getByText('You are invisible: others see you as offline.')).toBeVisible()
    await expect(person(ana, benName)).toContainText('Guest · Online')

    // And they can still write to each other.
    await send(ana, 'quietly, yes')
    await send(ben, 'I thought you had left')
    const conversation = ['are you there?', 'quietly, yes', 'I thought you had left']
    await expect(bubbles(ben)).toHaveText(conversation)
    await expect(bubbles(ana)).toHaveText(conversation)
    await expect(person(ben, anaName)).toBeHidden()

    // Someone who arrives now does not see her either; she sees them.
    const calName = unique('cal')
    const cal = await openApp(browser)
    await joinAsGuest(cal, calName)
    await expect(person(cal, benName)).toBeVisible()
    await expect(person(cal, anaName)).toBeHidden()
    await expect(person(ana, calName)).toBeVisible()

    // Back again: she reappears for both.
    await chooseStatus(ana, anaName, 'Online')
    await expect(person(ben, anaName)).toContainText('Guest · Online')
    await expect(person(cal, anaName)).toContainText('Guest · Online')
    await expect(ana.getByText(/You are invisible/)).toBeHidden()
})
