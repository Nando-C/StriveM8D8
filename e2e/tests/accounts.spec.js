import { expect, test } from './test.js'
import {
    PASSWORD, accountMenu, bubbles, chat, createAccount, joinAsGuest, openApp, openTab, people, person, send, signIn,
    signedInAs, unique,
} from './helpers.js'

test('an account is created with a recovery code, and is then signed in on every visit', async ({ browser }) => {
    const name = unique('ana')
    const ana = await openApp(browser)

    const code = await createAccount(ana, name)

    expect(code).toMatch(/^([A-Z2-9]{5}-){3}[A-Z2-9]{5}$/)
    // A reload, and a new tab of the same browser: both are straight in.
    await ana.reload()
    await signedInAs(ana, name)
    const tab = await openTab(ana.context())
    await signedInAs(tab, name)
    // Nobody can use the name as a guest.
    const guest = await openApp(browser)
    await joinAsGuest(guest, name)
    await expect(guest.getByRole('alert')).toHaveText('That name belongs to an account — sign in')
    expect(ana.consoleErrors).toEqual([])
})

test('one account on two browsers at once: listed once, messages on both, and one can sign the other out', async ({ browser }) => {
    const [name, friendName] = [unique('ben'), unique('fay')]
    const laptop = await openApp(browser)
    await createAccount(laptop, name)
    const friend = await openApp(browser)
    await joinAsGuest(friend, friendName)

    const phone = await openApp(browser)
    await signIn(phone, name)
    await signedInAs(phone, name)
    // To everyone else there is one of them.
    await expect(people(friend).getByRole('button').filter({ hasText: name })).toHaveCount(1)
    await expect(person(friend, name)).not.toContainText('Guest')

    // A message to them arrives on both; one sent from the laptop shows on the phone as their own.
    await person(friend, name).click()
    await send(friend, 'which device are you on?')
    await expect(chat(laptop, friendName)).toContainText('1 unread message')
    await expect(chat(phone, friendName)).toContainText('1 unread message')
    await chat(laptop, friendName).click()
    // Reading it on one device clears it on the other.
    await expect(chat(phone, friendName)).not.toContainText('unread')
    await send(laptop, 'both, it seems')
    await chat(phone, friendName).click()
    await expect(bubbles(phone)).toHaveText(['which device are you on?', 'both, it seems'])
    await expect(phone.getByRole('log').getByRole('listitem').filter({ hasText: 'both, it seems' })).toContainText('You:')

    // The laptop signs the phone out, from the list of devices.
    await accountMenu(laptop, name, 'Devices')
    const devices = laptop.getByRole('dialog', { name: 'Devices' }).getByRole('listitem')
    await expect(devices).toHaveCount(2)
    await devices.filter({ hasNotText: 'This device' }).getByRole('button', { name: 'Sign out' }).click()

    await expect(phone.getByRole('alert')).toHaveText('Signed out from another device')
    await expect(devices).toHaveCount(1)
    // Still online to the friend, through the laptop; and the phone does not come back by itself.
    await expect(person(friend, name)).toContainText('Online')
    await phone.reload()
    await expect(phone.getByRole('tab', { name: 'Sign in' })).toBeVisible()
    expect([...laptop.consoleErrors, ...phone.consoleErrors]).toEqual([])
})

test('a forgotten password is replaced with the recovery code', async ({ browser }) => {
    const name = unique('cal')
    const first = await openApp(browser)
    const code = await createAccount(first, name)
    const newPassword = 'a different password entirely'

    const elsewhere = await openApp(browser)
    await elsewhere.getByRole('tab', { name: 'Sign in' }).click()
    await elsewhere.getByRole('button', { name: 'Forgot your password?' }).click()
    await elsewhere.getByLabel('Username').fill(name)
    await elsewhere.getByLabel('Recovery code').fill(code.toLowerCase())
    await elsewhere.getByLabel('New password').fill(newPassword)
    await elsewhere.getByRole('button', { name: 'Set new password' }).click()

    // A new code replaces the one just used, and then they are in.
    const replacement = await elsewhere.getByRole('status', { name: 'Recovery code' }).textContent()
    expect(replacement).not.toBe(code)
    await elsewhere.getByRole('button', { name: 'I’ve saved it' }).click()
    await signedInAs(elsewhere, name)
    // Every device that was signed in is signed out.
    await expect(first.getByRole('alert')).toHaveText('The password was reset')

    // The old password is dead, the new one works.
    await signIn(first, name, PASSWORD)
    await expect(first.getByRole('alert')).toHaveText('Wrong username or password')
    await first.getByLabel('Password').fill(newPassword)
    await first.getByRole('button', { name: 'Sign in' }).click()
    await signedInAs(first, name)
})

test('a guest keeps their name and their conversations by creating an account', async ({ browser }) => {
    const [name, friendName] = [unique('dee'), unique('gus')]
    const dee = await openApp(browser)
    await joinAsGuest(dee, name)
    const friend = await openApp(browser)
    await joinAsGuest(friend, friendName)
    await person(dee, friendName).click()
    await send(dee, 'sent as a guest')
    await expect(person(friend, name)).toContainText('Guest')

    await accountMenu(dee, name, 'Create an account to keep this name')
    const dialog = dee.getByRole('dialog', { name: 'Create an account' })
    await dialog.getByLabel('Password').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Create account' }).click()
    await expect(dialog.getByRole('status', { name: 'Recovery code' })).toBeVisible()
    await dialog.getByRole('button', { name: 'I’ve saved it' }).click()

    // Others see the same person, no longer a guest, who never went away.
    await expect(person(friend, name)).not.toContainText('Guest')
    await expect(person(friend, name)).toContainText('Online')
    // From another browser, with the password: the same conversations.
    const elsewhere = await openApp(browser)
    await signIn(elsewhere, name)
    await chat(elsewhere, friendName).click()
    await expect(bubbles(elsewhere)).toHaveText(['sent as a guest'])
})

test('signing out ends the session on that device, and deleting the account frees the name', async ({ browser }) => {
    const name = unique('eve')
    const eve = await openApp(browser)
    await createAccount(eve, name)

    await accountMenu(eve, name, 'Sign out')
    await expect(eve.getByRole('tab', { name: 'Sign in' })).toBeVisible()
    await eve.reload()
    await expect(eve.getByRole('tab', { name: 'Sign in' })).toBeVisible()

    await signIn(eve, name)
    await accountMenu(eve, name, 'Delete account')
    const dialog = eve.getByRole('dialog', { name: 'Delete account' })
    await dialog.getByLabel('Password').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Delete my account' }).click()
    await expect(eve.getByRole('tab', { name: 'Sign in' })).toBeVisible()

    // The account is gone, and the name can be taken — by a guest, even.
    await signIn(eve, name)
    await expect(eve.getByRole('alert')).toHaveText('Wrong username or password')
    await eve.getByRole('tab', { name: 'Guest' }).click()
    await joinAsGuest(eve, name)
    await signedInAs(eve, name)
})
