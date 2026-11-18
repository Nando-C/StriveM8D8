import { expect, test } from '@playwright/test'
import { bubbles, chat, joinAsGuest, messageRow, openApp, openTab, person, send, signedInAs, tick, unique } from './helpers.js'

const twoGuests = async browser => {
    const [anaName, benName] = [unique('ana'), unique('ben')]
    const ana = await openApp(browser)
    await joinAsGuest(ana, anaName)
    const ben = await openApp(browser)
    await joinAsGuest(ben, benName)
    await signedInAs(ana, anaName)
    await signedInAs(ben, benName)
    return { ana, ben, anaName, benName }
}

test('a message goes from one tick, to two when it reaches the other person, to coloured when they read it', async ({ browser }) => {
    const { ana, ben, anaName, benName } = await twoGuests(browser)
    await person(ana, benName).click()

    await send(ana, 'did this reach you?')
    // Ben's browser has it — he has not opened the conversation.
    await expect(tick(ana, 'did this reach you?')).toHaveAttribute('data-tick', 'delivered')
    await expect(messageRow(ana, 'did this reach you?')).toContainText('Delivered')
    await expect(chat(ben, anaName)).toContainText('1 unread message')

    await chat(ben, anaName).click()
    await expect(tick(ana, 'did this reach you?')).toHaveAttribute('data-tick', 'seen')
    await expect(messageRow(ana, 'did this reach you?')).toContainText('Seen')

    // With the conversation open on both sides, each new message is seen as it arrives.
    await send(ben, 'it did')
    await expect(tick(ben, 'it did')).toHaveAttribute('data-tick', 'seen')
    await send(ana, 'good')
    await expect(tick(ana, 'good')).toHaveAttribute('data-tick', 'seen')
    // The other person's messages carry no ticks.
    await expect(messageRow(ana, 'it did').locator('[data-tick]')).toHaveCount(0)
    expect([...ana.consoleErrors, ...ben.consoleErrors]).toEqual([])
})

test('a message to someone who is offline stays at one tick until they are back', async ({ browser }) => {
    const { ana, ben, anaName, benName } = await twoGuests(browser)
    await person(ana, benName).click()
    const benContext = ben.context()
    await ben.close()
    await expect(ana.getByText('Offline — they will see your messages when they are back')).toBeVisible()

    await send(ana, 'for when you are back')
    await expect(tick(ana, 'for when you are back')).toHaveAttribute('data-tick', 'sent')
    // Still one tick a moment later: nothing has received it.
    await ana.waitForTimeout(1000)
    await expect(tick(ana, 'for when you are back')).toHaveAttribute('data-tick', 'sent')

    // He logs in: it is on his device, in the list. Two ticks.
    const back = await openTab(benContext)
    await joinAsGuest(back, benName)
    await expect(chat(back, anaName)).toContainText('1 unread message')
    await expect(tick(ana, 'for when you are back')).toHaveAttribute('data-tick', 'delivered')

    // He opens it: seen.
    await chat(back, anaName).click()
    await expect(tick(ana, 'for when you are back')).toHaveAttribute('data-tick', 'seen')

    // And the sender still sees that after a reload.
    await ana.reload()
    await chat(ana, benName).click()
    await expect(bubbles(ana)).toHaveText(['for when you are back'])
    await expect(tick(ana, 'for when you are back')).toHaveAttribute('data-tick', 'seen')
})

test('an invisible reader does not turn the ticks: not live, not after the sender reloads, until they are visible again', async ({ browser }) => {
    const { ana, ben, anaName, benName } = await twoGuests(browser)
    await person(ana, benName).click()
    await send(ana, 'first')
    await chat(ben, anaName).click()
    await expect(tick(ana, 'first')).toHaveAttribute('data-tick', 'seen')

    // Ben goes invisible, with the conversation still open in front of him.
    await ben.getByRole('button', { name: `Account menu for ${benName}` }).click()
    await ben.getByRole('menuitemradio', { name: /^Invisible/ }).click()
    await expect(person(ana, benName)).toBeHidden()

    await send(ana, 'second')
    // He has it and has read it…
    await expect(bubbles(ben)).toHaveText(['first', 'second'])
    // …and ana is shown none of that.
    await ana.waitForTimeout(1500)
    await expect(tick(ana, 'second')).toHaveAttribute('data-tick', 'sent')
    await ana.reload()
    await chat(ana, benName).click()
    await expect(bubbles(ana)).toHaveText(['first', 'second'])
    await expect(tick(ana, 'second')).toHaveAttribute('data-tick', 'sent')
    await expect(tick(ana, 'first')).toHaveAttribute('data-tick', 'seen')

    // Visible again: it catches up at once.
    await ben.getByRole('button', { name: `Account menu for ${benName}` }).click()
    await ben.getByRole('menuitemradio', { name: /^Online/ }).click()
    await expect(tick(ana, 'second')).toHaveAttribute('data-tick', 'seen')
})
