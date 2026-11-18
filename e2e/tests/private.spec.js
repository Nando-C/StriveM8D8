import { expect, test } from '@playwright/test'
import { BOOTSTRAP_CODE, OWNER } from '../profiles.js'
import {
    accountMenu, bubbles, chat, fillSignUp, menuButton, openApp, openTab, people, person, send, signIn, signedInAs, unique,
} from './helpers.js'

// The same code as a private deployment: accounts only, by invitation, every member
// listed. These run in order — the owner has to exist before anyone can be invited.
test.describe.configure({ mode: 'serial' })

// Signs the owner in and has them make an invitation link.
const invite = async browser => {
    const owner = await openApp(browser)
    await signIn(owner, OWNER)
    await accountMenu(owner, OWNER, 'Invite someone')
    const dialog = owner.getByRole('dialog', { name: 'Invite someone' })
    await dialog.getByRole('button', { name: /Create an(other)? invitation link|Create another/ }).click()
    const link = await dialog.getByRole('status', { name: 'Invitation link' }).textContent()
    return { owner, dialog, link }
}

test('there is no way in without an account, and no way to make one without an invitation', async ({ browser }) => {
    const visitor = await openApp(browser)

    await expect(visitor.getByRole('tab', { name: 'Sign in' })).toBeVisible()
    await expect(visitor.getByRole('tab', { name: 'Guest' })).toBeHidden()
    await expect(visitor.getByRole('button', { name: 'Join' })).toBeHidden()

    await visitor.getByRole('tab', { name: 'Create account' }).click()
    await visitor.getByLabel('Invitation code').fill('made-up-code')
    await fillSignUp(visitor, unique('eve'))
    await expect(visitor.getByRole('alert')).toHaveText('That invitation is not valid any more')
    // The owner's name cannot be picked up without the owner's code either.
    await visitor.getByLabel('Username').fill(OWNER)
    await visitor.getByRole('button', { name: 'Create account' }).click()
    await expect(visitor.getByRole('alert')).toHaveText('That name is reserved')
})

test('the owner registers with the bootstrap link, as an administrator', async ({ browser }) => {
    const owner = await openApp(browser, {}, `/?bootstrap=${BOOTSTRAP_CODE}`)

    await expect(owner.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true')
    await expect(owner.getByLabel('Invitation code')).toBeHidden()
    await fillSignUp(owner, OWNER)
    await owner.getByRole('button', { name: 'I’ve saved it' }).click()
    await signedInAs(owner, OWNER)

    // The code is gone from the address bar, and the owner can invite people.
    expect(new URL(owner.url()).search).toBe('')
    await menuButton(owner, OWNER).click()
    await expect(owner.getByRole('menuitem', { name: 'Invite someone' })).toBeVisible()
    await expect(owner.getByText(`${OWNER} · Account · Administrator`)).toBeVisible()
})

test('an invitation link lets exactly one person in', async ({ browser }) => {
    const { owner, dialog, link } = await invite(browser)
    expect(link).toContain('/?invite=')
    await expect(dialog.getByRole('list', { name: 'Unused invitations' }).getByRole('listitem')).toHaveCount(1)
    const anaName = unique('ana')

    // The invited person follows the link: the sign-up form, with the code filled in.
    const ana = await openApp(browser, {}, link)
    await expect(ana.getByLabel('Invitation code')).not.toHaveValue('')
    await fillSignUp(ana, anaName)
    await ana.getByRole('button', { name: 'I’ve saved it' }).click()
    await signedInAs(ana, anaName)
    // Members are not administrators.
    await menuButton(ana, anaName).click()
    await expect(ana.getByRole('menuitem', { name: 'Devices' })).toBeVisible()
    await expect(ana.getByRole('menuitem', { name: 'Invite someone' })).toBeHidden()

    // Somebody the link was passed on to finds it used up.
    const second = await openApp(browser, {}, link)
    await fillSignUp(second, unique('zed'))
    await expect(second.getByRole('alert')).toHaveText('That invitation is not valid any more')
    await owner.close()
})

test('a member who is not online is still listed, and can be written to', async ({ browser }) => {
    // A new member registers and goes away again.
    const { owner, dialog, link } = await invite(browser)
    const benName = unique('ben')
    const ben = await openApp(browser, {}, link)
    await fillSignUp(ben, benName)
    await ben.getByRole('button', { name: 'I’ve saved it' }).click()
    await signedInAs(ben, benName)
    const benContext = ben.context()
    await ben.close()

    // The owner sees them under People (not "People online"), marked offline.
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(owner.getByRole('navigation', { name: 'People', exact: true })).toBeVisible()
    await expect(person(owner, benName)).toContainText('Offline')
    await person(owner, benName).click()
    await send(owner, 'welcome aboard')
    await expect(chat(owner, benName)).toContainText('You: welcome aboard')

    // And they find it when they come back.
    const back = await openTab(benContext)
    await signedInAs(back, benName)
    await expect(chat(back, OWNER)).toContainText('1 unread message')
    await chat(back, OWNER).click()
    await expect(bubbles(back)).toHaveText(['welcome aboard'])
    // The directory is the same for every member.
    await expect(people(back)).toContainText(OWNER)
    expect([...owner.consoleErrors, ...back.consoleErrors]).toEqual([])
})

test('nothing about the members is public', async ({ request }) => {
    const { PROFILES } = await import('../profiles.js')
    const server = `http://localhost:${PROFILES.private.serverPort}`

    expect((await request.get(`${server}/online-users`)).status()).toBe(404)
    const config = await (await request.get(`${server}/config`)).json()
    expect(config).toEqual({ signup: 'invite', guests: false, protocol: 2 })
})
