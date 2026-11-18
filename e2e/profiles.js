// The two deployments the suite runs against: the same code, different settings.
// Each gets its own database, server and built client, on its own ports.

export const BOOTSTRAP_CODE = 'e2e-bootstrap-code'
export const OWNER = 'owner'

// Both run behind "one proxy": the tests give each browser its own X-Forwarded-For
// address (tests/helpers.js), so that the per-address limits see separate visitors, as
// they would in production behind a host's proxy.
const BEHIND_ONE_PROXY = { TRUSTED_PROXY_HOPS: '1' }

export const PROFILES = {
    // The public demo: every default, plus the bot and message expiry.
    demo: {
        clientPort: 4100,
        serverPort: 4101,
        env: { ...BEHIND_ONE_PROXY, DEMO_BOT: 'true', MESSAGE_TTL_HOURS: '24' },
    },
    // A private deployment: accounts only, by invitation, everyone listed.
    private: {
        clientPort: 4110,
        serverPort: 4111,
        env: {
            ...BEHIND_ONE_PROXY,
            SIGNUP_MODE: 'invite',
            GUESTS: 'false',
            ADMIN_USERNAMES: OWNER,
            SIGNUP_BOOTSTRAP_CODE: BOOTSTRAP_CODE,
            MEMBER_DIRECTORY: 'all',
            MESSAGE_TTL_HOURS: '0',
        },
    },
}

// "localhost", not 127.0.0.1: the server only admits the origin it is told about,
// and to a browser those are two different origins.
export const clientUrl = profile => `http://localhost:${PROFILES[profile].clientPort}`
export const serverUrl = profile => `http://localhost:${PROFILES[profile].serverPort}`
