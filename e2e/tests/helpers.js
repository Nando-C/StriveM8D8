import { randomBytes } from 'node:crypto'
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
    const [anaName, benName] = [unique('ana'), unique('ben')]
    const ana = await openApp(browser)
    await joinAsGuest(ana, anaName)
    const ben = await openApp(browser)
    await joinAsGuest(ben, benName)
    await signedInAs(ana, anaName)
    await signedInAs(ben, benName)
    return { ana, ben, anaName, benName }
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
/** Every message bubble in the open conversation, in order. */
export const bubbles = page => log(page).locator('li > p:first-of-type')
/** The row (author, text, status) of the message with exactly this text. */
export const messageRow = (page, text) => log(page).getByRole('listitem').filter({ has: page.getByText(text, { exact: true }) })
