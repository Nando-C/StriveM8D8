import { defineConfig, devices } from '@playwright/test'
import { PROFILES, clientUrl } from './profiles.js'

const CI = Boolean(process.env.CI)

// One whole deployment per profile (see stack.js), started before the tests and stopped
// after them. Nothing is reused from an earlier run: every run starts from an empty database.
const stack = profile => ({
    name: profile,
    command: `node stack.js ${profile}`,
    url: clientUrl(profile),
    reuseExistingServer: false,
    // Includes building the client, and downloading MongoDB the first time.
    timeout: 180_000,
    // The server logs every connection: only what goes wrong is worth showing here.
    stdout: 'ignore',
    stderr: 'pipe',
    // Lets the stack stop its own children (database, server, client) cleanly.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
})

export default defineConfig({
    testDir: './tests',
    // Tests share one server per profile but never a user: each makes up its own names.
    fullyParallel: true,
    forbidOnly: CI,
    // No retries, here or in CI: a test that passes on the second go is a flaky test.
    retries: 0,
    reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
    timeout: 30_000,
    expect: { timeout: 7000 },
    use: {
        ...devices['Desktop Chrome'],
        // Calls: a made-up camera and microphone (a moving test picture and a beep), and
        // no question asked about using them.
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
        // Kept only when something fails: the trace is what explains a failure in CI.
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        { name: 'demo', testIgnore: /private\.spec\.js$/, use: { baseURL: clientUrl('demo') } },
        { name: 'private', testMatch: /private\.spec\.js$/, use: { baseURL: clientUrl('private') } },
    ],
    webServer: Object.keys(PROFILES).map(stack),
})
