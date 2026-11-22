import { expect, test } from './test.js'
import { accountMenu, joinAsGuest, openApp, openTab, people, person, signedInAs, unique } from './helpers.js'

test('a guest gets in with a name alone, and the name is then theirs', async ({ browser }) => {
    const name = unique('ana')
    const ana = await openApp(browser)

    await expect(ana.getByRole('tab', { name: 'Guest' })).toHaveAttribute('aria-selected', 'true')
    await joinAsGuest(ana, name)
    await signedInAs(ana, name)

    // Somebody else, in another browser, cannot take it.
    const impostor = await openApp(browser)
    await joinAsGuest(impostor, name)
    await expect(impostor.getByRole('alert')).toHaveText('Username already in use')
    await expect(impostor.getByLabel('Username')).toBeEnabled()
    // Not even once its owner has closed their browser tab.
    await ana.close()
    await impostor.getByRole('button', { name: 'Join' }).click()
    await expect(impostor.getByRole('alert')).toHaveText('Username already in use')
})

test('a guest who comes back in the same browser has their name back', async ({ browser }) => {
    const name = unique('ben')
    const first = await openApp(browser)
    await joinAsGuest(first, name)
    await signedInAs(first, name)
    const context = first.context()

    // A reload: signed straight back in, no form.
    await first.reload()
    await signedInAs(first, name)

    // The tab is closed and the site opened again later: the name has to be typed, and is accepted.
    await first.close()
    const later = await openTab(context)
    await expect(later.getByLabel('Username')).toBeVisible()
    await joinAsGuest(later, name)
    await signedInAs(later, name)
})

test('two tabs of one browser can be two different guests', async ({ browser }) => {
    const [one, two] = [unique('cal'), unique('dee')]
    const first = await openApp(browser)
    await joinAsGuest(first, one)
    await signedInAs(first, one)

    const second = await openTab(first.context())
    await joinAsGuest(second, two)
    await signedInAs(second, two)

    await expect(person(first, two)).toBeVisible()
    await expect(person(second, one)).toBeVisible()
    // Each tab is still who it was after a reload.
    await first.reload()
    await signedInAs(first, one)
})

test('someone who leaves disappears from everyone’s list promptly', async ({ browser }) => {
    const [stays, leaves] = [unique('eve'), unique('fay')]
    const eve = await openApp(browser)
    await joinAsGuest(eve, stays)
    const fay = await openApp(browser)
    await joinAsGuest(fay, leaves)
    await expect(person(eve, leaves)).toContainText('Guest · Online')

    await fay.close()

    // Well inside the server's heartbeat timeout: the page said goodbye as it closed.
    await expect(person(eve, leaves)).toBeHidden({ timeout: 3000 })
    await expect(people(eve)).not.toContainText(leaves)
})

test('a guest can leave from the menu and is back on the entry screen', async ({ browser }) => {
    const name = unique('gus')
    const gus = await openApp(browser)
    await joinAsGuest(gus, name)
    await signedInAs(gus, name)

    await accountMenu(gus, name, 'Leave')

    await expect(gus.getByLabel('Username')).toBeVisible()
    // And does not sign itself back in on a reload.
    await gus.reload()
    await expect(gus.getByLabel('Username')).toBeVisible()
    expect(gus.consoleErrors).toEqual([])
})
