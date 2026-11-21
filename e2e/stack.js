// Starts one whole deployment for the browser tests and keeps it running:
//
//   an in-memory MongoDB  →  the real server (src/index.js)  →  the client, built for
//   production and served as static files on its own origin.
//
// That is the shape the app is deployed in — two origins, a built client — rather than
// the development servers. Usage: node stack.js <profile>  (see profiles.js).
// Playwright starts this through `webServer` and stops it when the run ends.

import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { PROFILES, clientUrl, serverUrl } from './profiles.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const client = path.join(root, 'client')
// Vite is run with node directly rather than through pnpm: a wrapper in between does not
// pass a stop signal on, and the preview server would outlive the run, holding its port.
const vite = path.join(client, 'node_modules', 'vite', 'bin', 'vite.js')

const name = process.argv[2]
const profile = PROFILES[name]
if (!profile) {
    console.error(`usage: node stack.js <${Object.keys(PROFILES).join('|')}>`)
    process.exit(2)
}
const log = message => console.log(`[${name}] ${message}`)

const children = []
let mongo = null
let stopping = false

const stop = async code => {
    if (stopping) return
    stopping = true
    for (const child of children) child.kill('SIGTERM')
    await mongo?.stop().catch(() => {})
    process.exit(code)
}
process.on('SIGTERM', () => stop(0))
process.on('SIGINT', () => stop(0))

// Runs a command to completion.
const run = (command, args, options) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))))
})

// Starts a long-running command. If it ever exits, the stack is no use: stop everything.
const start = (label, command, args, options) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options })
    children.push(child)
    child.on('error', error => {
        console.error(`[${name}] ${label} could not start: ${error.message}`)
        void stop(1)
    })
    child.on('exit', code => {
        if (!stopping) {
            console.error(`[${name}] ${label} exited unexpectedly (${code})`)
            void stop(1)
        }
    })
}

const waitFor = async (url, what, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        try {
            if ((await fetch(url)).ok) return
        } catch {
            // Not listening yet.
        }
        if (Date.now() > deadline) throw new Error(`${what} did not answer at ${url}`)
        await new Promise(resolve => setTimeout(resolve, 200))
    }
}

const uploads = path.join(here, '.build', `uploads-${name}`)

try {
    await rm(uploads, { recursive: true, force: true })
    // Given a minute to start rather than the default ten seconds: two of these start
    // side by side (one per profile), and on a busy CI machine ten is not always enough.
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
    log('database started')

    start('server', process.execPath, ['src/index.js'], {
        cwd: root,
        env: {
            ...process.env,
            // Every setting is given a value, empty if need be: src/index.js also reads
            // a developer's .env, which must not leak into what is being tested.
            DEMO_BOT: '', MESSAGE_TTL_HOURS: '', SIGNUP_MODE: '', GUESTS: '', ADMIN_USERNAMES: '',
            SIGNUP_BOOTSTRAP_CODE: '', MEMBER_DIRECTORY: '', TRUSTED_PROXY_HOPS: '',
            FILE_STORAGE: '', UPLOAD_MAX_FILE_MB: '', UPLOAD_MAX_USER_MB_PER_DAY: '',
            UPLOAD_MAX_ADDRESS_MB_PER_DAY: '', UPLOAD_MAX_TOTAL_MB: '',
            // Where a profile with local file storage keeps its files: emptied at each start.
            FILE_STORAGE_DIR: uploads,
            ...profile.env,
            PORT: String(profile.serverPort),
            FRONTEND_URL: clientUrl(name),
            MONGO_CONNECTION: `${mongo.getUri()}strive-chat-e2e`,
        },
    })
    await waitFor(`${serverUrl(name)}/health`, 'the server')
    log(`server up at ${serverUrl(name)}`)

    // The server's address is built into the client, so each profile needs its own build.
    // (Vite only: the type check belongs to the client's own build, which CI also runs.)
    const outDir = path.join(here, '.build', name)
    const buildEnv = { ...process.env, VITE_BACKEND_URL: serverUrl(name) }
    await run(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], { cwd: client, env: buildEnv })
    start('client', process.execPath, [
        vite, 'preview', '--outDir', outDir, '--host', 'localhost',
        '--port', String(profile.clientPort), '--strictPort',
    ], { cwd: client, env: buildEnv })
    await waitFor(clientUrl(name), 'the client')
    // Playwright waits for this URL, and it is the last thing to come up.
    log(`ready: client at ${clientUrl(name)}`)
} catch (error) {
    console.error(`[${name}] ${error.message}`)
    await stop(1)
}
