import { expect, test } from './test.js'
import {
    bubbles, chat, chats, choosePeople, composer, createGroup, groupDetails, guests, messageRow, SAVED, send, tick,
} from './helpers.js'

test('a group: made, talked in, joined later, someone removed, someone leaving', async ({ browser }) => {
    const [ana, ben, cy, dee] = await guests(browser, 'ana', 'ben', 'cy', 'dee')

    // Ana makes a group with ben and cy.
    await createGroup(ana.page, 'Trip to Rome', ben.name, cy.name)
    await expect(bubbles(ana.page)).toHaveText(['You created the group “Trip to Rome”'])
    for (const member of [ben, cy]) {
        await expect(chat(member.page, 'Trip to Rome')).toContainText(`${ana.name} created the group “Trip to Rome”`)
        // Being put in a group is not a message to read.
        await expect(chat(member.page, 'Trip to Rome')).not.toContainText('unread')
    }
    await expect(chats(dee.page)).toHaveCount(0)

    // They talk: everyone gets each message once, and sees who wrote it.
    await send(ana.page, 'shall we book?')
    await expect(chat(ben.page, 'Trip to Rome')).toContainText(`${ana.name}: shall we book?`)
    await expect(chat(ben.page, 'Trip to Rome')).toContainText('1 unread message')
    await chat(ben.page, 'Trip to Rome').click()
    await chat(cy.page, 'Trip to Rome').click()
    await send(ben.page, 'yes — flights are cheap')
    await send(ben.page, 'I can do May')
    const soFar = [`${ana.name} created the group “Trip to Rome”`, 'shall we book?', 'yes — flights are cheap', 'I can do May']
    await expect(bubbles(cy.page)).toHaveText(soFar)
    await expect(bubbles(ana.page)).toHaveText(['You created the group “Trip to Rome”', ...soFar.slice(1)])
    await expect(messageRow(cy.page, 'shall we book?')).toContainText(`${ana.name}:`)
    // Ben's two in a row carry his name once.
    await expect(cy.page.getByRole('log').locator('[data-sender]')).toHaveText([ana.name, ben.name])

    // Both of the others have read ana's message: it is seen, and she can ask by whom.
    await expect(tick(ana.page, 'shall we book?')).toHaveAttribute('data-tick', 'seen')
    await messageRow(ana.page, 'shall we book?').getByRole('button', { name: /show who has seen this/ }).click()
    await expect(ana.page.getByRole('dialog')).toContainText(ben.name)
    await expect(ana.page.getByRole('dialog')).toContainText(cy.name)
    await ana.page.keyboard.press('Escape')

    // Ben, who is not the admin, adds dee. She starts from there: nothing earlier.
    const forBen = await groupDetails(ben.page, 'Trip to Rome')
    await expect(forBen).toContainText(`3 members · ${ana.name} is the admin`)
    await expect(forBen.getByRole('button', { name: /^Remove/ })).toHaveCount(0)
    await forBen.getByRole('button', { name: 'Add people' }).click()
    await choosePeople(forBen, dee.name)
    await forBen.getByRole('button', { name: 'Add to group' }).click()
    await expect(forBen).toContainText('4 members')
    await ben.page.keyboard.press('Escape')
    await expect(bubbles(ana.page).last()).toHaveText(`${ben.name} added ${dee.name}`)

    await chat(dee.page, 'Trip to Rome').click()
    await expect(dee.page.getByText('You were added to this group here. Earlier messages are not shown.')).toBeVisible()
    await expect(bubbles(dee.page)).toHaveCount(0)
    await send(dee.page, 'hello everyone')
    await expect(bubbles(ana.page).last()).toHaveText('hello everyone')
    await expect(bubbles(dee.page)).toHaveText(['hello everyone'])
    // An earlier message is not un-seen because someone new has not read it.
    await expect(tick(ana.page, 'shall we book?')).toHaveAttribute('data-tick', 'seen')

    // Ana, the admin, renames the group and removes cy.
    const forAna = await groupDetails(ana.page, 'Trip to Rome')
    await forAna.getByLabel('Group name').fill('Rome in May')
    await forAna.getByRole('button', { name: 'Rename' }).click()
    await expect(ana.page.getByRole('dialog', { name: 'Rome in May' })).toBeVisible()
    await expect(chat(dee.page, 'Rome in May')).toBeVisible()

    const renamed = ana.page.getByRole('dialog', { name: 'Rome in May' })
    await renamed.getByRole('button', { name: `Remove ${cy.name}` }).click()
    await expect(renamed).toContainText('3 members')
    await ana.page.keyboard.press('Escape')
    // Cy had it open: it closes, and is gone from his list.
    await expect(composer(cy.page)).toHaveCount(0)
    await expect(chats(cy.page)).toHaveCount(0)
    await send(ana.page, 'after cy')
    await expect(messageRow(ana.page, 'after cy')).toContainText(SAVED)
    await expect(bubbles(dee.page).last()).toHaveText('after cy')
    await cy.page.reload()
    await expect(cy.page.getByRole('navigation', { name: /^People/ })).toBeVisible()
    await expect(chats(cy.page)).toHaveCount(0)

    // Ana leaves, after being asked whether she means it; ben, there longest, is the admin now.
    const leaving = await groupDetails(ana.page, 'Rome in May')
    await leaving.getByRole('button', { name: 'Leave group' }).click()
    await expect(leaving).toContainText('Leave “Rome in May”?')
    await leaving.getByRole('region', { name: 'Leave group' }).getByRole('button', { name: 'Leave group' }).click()
    await expect(chats(ana.page)).toHaveCount(0)
    await expect(composer(ana.page)).toHaveCount(0)

    await expect(bubbles(ben.page).last()).toHaveText(`${ana.name} left`)
    const nowBen = await groupDetails(ben.page, 'Rome in May')
    await expect(nowBen).toContainText('2 members · You are the admin')
    await expect(nowBen.getByRole('button', { name: `Remove ${dee.name}` })).toBeVisible()

    // A reload shows the same group, from the server.
    await dee.page.reload()
    await chat(dee.page, 'Rome in May').click()
    await expect(bubbles(dee.page)).toHaveText([
        'hello everyone', `${ana.name} renamed the group to “Rome in May”`, `${ana.name} removed ${cy.name}`, 'after cy', `${ana.name} left`,
    ])

    expect([ana, ben, cy, dee].flatMap(({ page }) => page.consoleErrors)).toEqual([])
})

test('the demo bot can be in a group, and answers when it is spoken to', async ({ browser }) => {
    const [ana, ben] = await guests(browser, 'ana', 'ben')
    await createGroup(ana.page, 'With the bot', ben.name, 'demo-bot')
    await chat(ben.page, 'With the bot').click()

    await send(ana.page, 'just between us')
    await send(ana.page, '@demo-bot hello')
    await expect(bubbles(ben.page).last()).toContainText('Hello!')
    await expect(bubbles(ben.page)).toHaveCount(4)
    // The bot never reads the rest; the message is seen all the same once ben has.
    await expect(tick(ana.page, 'just between us')).toHaveAttribute('data-tick', 'seen')
})
