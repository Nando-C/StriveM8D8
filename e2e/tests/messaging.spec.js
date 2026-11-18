import { expect, test } from '@playwright/test'
import {
    bubbles, chat, chats, composer, joinAsGuest, log, SAVED, messageRow, openApp, openTab, person, send, signedInAs, twoGuests, unique,
} from './helpers.js'

test('a conversation between two people: each message arrives once, on both sides, in order', async ({ browser }) => {
    const { ana, ben, anaName, benName } = await twoGuests(browser)

    await person(ana, benName).click()
    await send(ana, 'hello ben')
    await expect(messageRow(ana, 'hello ben')).toContainText(SAVED)

    // Ben did nothing, and has a chat waiting with a badge and a count in the tab title.
    await expect(chat(ben, anaName)).toContainText('hello ben')
    await expect(chat(ben, anaName)).toContainText('1 unread message')
    await expect(ben).toHaveTitle('(1) Strive Chat')

    await chat(ben, anaName).click()
    await expect(ben).toHaveTitle('Strive Chat')
    await send(ben, 'hello ana')
    await send(ana, 'how are you?')
    await send(ben, 'well, thanks')

    const conversation = ['hello ben', 'hello ana', 'how are you?', 'well, thanks']
    await expect(bubbles(ana)).toHaveText(conversation)
    await expect(bubbles(ben)).toHaveText(conversation)
    // Whose message is whose is clear on both sides.
    await expect(messageRow(ben, 'hello ben')).toContainText(`${anaName}:`)
    await expect(messageRow(ben, 'hello ana')).toContainText('You:')
    await expect(chat(ana, benName)).toContainText('well, thanks')
    await expect(chat(ana, benName)).not.toContainText('unread')
    expect([...ana.consoleErrors, ...ben.consoleErrors]).toEqual([])
})

test('a message to someone who is away waits for them, and is marked as new when they return', async ({ browser }) => {
    const { ana, ben, anaName, benName } = await twoGuests(browser)
    await person(ana, benName).click()
    await send(ana, 'before you left')
    await chat(ben, anaName).click()
    await expect(bubbles(ben)).toHaveText(['before you left'])
    const benContext = ben.context()

    // Ben goes away.
    await ben.close()
    await expect(ana.getByText('Offline — they will see your messages when they are back')).toBeVisible()
    await expect(composer(ana)).toBeEnabled()
    await send(ana, 'while you were out')
    await send(ana, 'and one more')
    await expect(messageRow(ana, 'and one more')).toContainText(SAVED)

    // Ben comes back later, in the same browser.
    const back = await openTab(benContext)
    await joinAsGuest(back, benName)
    await expect(chat(back, anaName)).toContainText('2 unread messages')
    await expect(chat(back, anaName)).toContainText('and one more')
    await expect(back).toHaveTitle('(2) Strive Chat')

    await chat(back, anaName).click()
    await expect(bubbles(back)).toHaveText(['before you left', 'while you were out', 'and one more'])
    // The line is drawn where he stopped reading.
    const line = log(back).getByRole('separator', { name: 'New messages' })
    await expect(line).toBeVisible()
    await expect(line.locator('xpath=following-sibling::li[1]')).toContainText('while you were out')
    await expect(back).toHaveTitle('Strive Chat')

    // Having read them, they are not new again next time.
    await back.reload()
    await expect(chat(back, anaName)).toBeVisible()
    await expect(chat(back, anaName)).not.toContainText('unread')
})

test('a reload restores the session, the chat list and the conversation', async ({ browser }) => {
    const { ana, ben, anaName, benName } = await twoGuests(browser)
    await person(ana, benName).click()
    await send(ana, 'one')
    await chat(ben, anaName).click()
    await send(ben, 'two')
    await expect(bubbles(ana)).toHaveText(['one', 'two'])

    await ana.reload()

    await signedInAs(ana, anaName)
    await expect(chat(ana, benName)).toContainText('two')
    await chat(ana, benName).click()
    await expect(bubbles(ana)).toHaveText(['one', 'two'])
    // And it still works: nothing is shown twice once messages flow again.
    await send(ana, 'three')
    await expect(bubbles(ben)).toHaveText(['one', 'two', 'three'])
    await expect(bubbles(ana)).toHaveText(['one', 'two', 'three'])
})

test('a third person sees nothing of a conversation they are not in', async ({ browser }) => {
    const { ana, ben, benName } = await twoGuests(browser)
    const eveName = unique('eve')
    const eve = await openApp(browser)
    await joinAsGuest(eve, eveName)
    await signedInAs(eve, eveName)

    await person(ana, benName).click()
    await send(ana, 'just between us')
    await expect(chats(ben)).toContainText('just between us')

    // Ben has it, so anything wrongly sent to Eve would have arrived by now.
    await expect(chats(eve)).toBeHidden()
    await expect(eve).toHaveTitle('Strive Chat')
    await person(eve, benName).click()
    await expect(eve.getByText('No messages yet')).toBeVisible()
    await expect(bubbles(eve)).toHaveCount(0)
})

test('the demo bot is there to talk to, and answers', async ({ browser }) => {
    const name = unique('ana')
    const ana = await openApp(browser)
    await joinAsGuest(ana, name)
    await expect(person(ana, 'demo-bot')).toContainText('Bot · Online')

    await person(ana, 'demo-bot').click()
    await send(ana, 'hello')

    await expect(bubbles(ana)).toHaveCount(2)
    await expect(bubbles(ana).nth(1)).toContainText('Hello!')
    await expect(messageRow(ana, 'hello')).toContainText(SAVED)
    await expect(chat(ana, 'demo-bot')).toBeVisible()
    // The conversation is stored like any other.
    await ana.reload()
    await chat(ana, 'demo-bot').click()
    await expect(bubbles(ana)).toHaveCount(2)
})

test('a long conversation loads a page at a time and keeps the reader’s place', async ({ browser }) => {
    // More than a page of messages has to be sent first, and the server allows each
    // connection ten every ten seconds: about a minute, whatever the machine.
    test.setTimeout(150_000)
    const { ana, ben, anaName, benName } = await twoGuests(browser)
    await person(ana, benName).click()
    await chat(ben, anaName).or(person(ben, anaName)).first().click()

    // 106 messages, split between the two so that neither runs into the per-connection limit for long.
    for (let index = 1; index <= 106; index++) {
        const from = index % 2 ? ana : ben
        await send(from, `message ${index}`)
        await expect(messageRow(from, `message ${index}`)).toContainText(SAVED)
        // Each of the two sends every other message: one a second each, just inside the limit.
        await from.waitForTimeout(520)
    }

    await ana.reload()
    await chat(ana, benName).click()
    await expect(bubbles(ana)).toHaveCount(100)
    await expect(bubbles(ana).first()).toHaveText('message 7')
    await expect(bubbles(ana).last()).toBeInViewport()

    await ana.getByRole('button', { name: 'Load earlier messages' }).click()
    await expect(bubbles(ana)).toHaveCount(106)
    await expect(bubbles(ana).first()).toHaveText('message 1')
    await expect(ana.getByRole('button', { name: 'Load earlier messages' })).toBeHidden()
    // The view did not jump to either end: what was at the top is still on screen.
    await expect(messageRow(ana, 'message 7')).toBeInViewport()
    await expect(bubbles(ana).last()).not.toBeInViewport()
})
