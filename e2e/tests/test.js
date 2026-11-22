import { test as base } from '@playwright/test'

export { devices, expect } from '@playwright/test'

// The `test` every spec uses. One thing is added to Playwright's own: when a test is
// over, every browser it opened is closed. The tests open their browsers themselves (one
// per person), and Playwright leaves those open until the worker has run all its tests —
// dozens of pages still connected and still being drawn, which is what made this suite
// slow enough, on a busy machine, for unrelated tests to run out of time.
export const test = base.extend({
    leavingNothingOpen: [
        async ({ browser }, use) => {
            await use()
            await Promise.all(browser.contexts().map(context => context.close()))
        },
        { auto: true },
    ],
})
