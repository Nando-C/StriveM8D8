// Everything that differs between deployments, in one place. `createApp()` takes these as
// options (so tests can run several configurations in one process) and `src/index.js`
// reads them from the environment.

export const SIGNUP_MODES = ['open', 'invite', 'closed']

const HOUR = 60 * 60_000

const DEFAULTS = Object.freeze({
    /** Adds an always-online user that replies (see bot.js). */
    demoBot: false,
    /** Who may create an account: anyone, only people with an invitation, or nobody. */
    signupMode: 'open',
    /** Whether a name alone, with no account, is enough to get in. */
    guests: true,
    /** Names only the deployment's owner can register, as administrators. */
    adminUsernames: [],
    /** The secret that registers those names. While unset, they cannot be registered. */
    bootstrapCode: null,
    /** How many proxies in front of the server may be believed about the client's address. */
    trustedProxyHops: 0,
    /** undefined: not configured. 0: nothing expires. Positive: hours until data expires. */
    messageTtlHours: undefined,
    /** scrypt parameters for new password hashes; undefined uses the production default. */
    passwordParams: undefined,
})

// Per client address, because a new socket costs nothing: each of these writes to the
// database (and registration also spends a password hash).
const DEFAULT_LIMITS = Object.freeze({
    registrationsPerAddress: { limit: 10, windowMs: HOUR },
    newGuestsPerAddress: { limit: 30, windowMs: HOUR },
})

/** Fills in defaults. Unknown or invalid values are a programming error here, so they throw. */
export const resolveSettings = (options = {}) => {
    const settings = { ...DEFAULTS, ...options, limits: { ...DEFAULT_LIMITS, ...options.limits } }
    if (!SIGNUP_MODES.includes(settings.signupMode)) {
        throw new TypeError(`signupMode must be one of ${SIGNUP_MODES.join(', ')}`)
    }
    settings.adminUsernames = [...settings.adminUsernames]
    settings.bootstrapCode = settings.bootstrapCode || null
    return settings
}

const list = value => (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean)

/**
 * Reads the settings from environment variables. A value that cannot be understood is
 * reported by name (never by content) and replaced with the safe default.
 */
export const settingsFromEnv = (env, warn = console.warn) => {
    const settings = {
        demoBot: env.DEMO_BOT === 'true',
        guests: env.GUESTS !== 'false',
        adminUsernames: list(env.ADMIN_USERNAMES),
        bootstrapCode: env.SIGNUP_BOOTSTRAP_CODE || null,
    }

    const mode = (env.SIGNUP_MODE ?? '').trim()
    if (mode === '' || SIGNUP_MODES.includes(mode)) {
        settings.signupMode = mode || 'open'
    } else {
        // An unreadable value must not open a deployment that was meant to be restricted.
        warn(" ⚠️  SIGNUP_MODE is not one of open, invite, closed: sign-up is closed")
        settings.signupMode = 'closed'
    }

    const hops = (env.TRUSTED_PROXY_HOPS ?? '').trim()
    if (hops !== '') {
        const parsed = Number(hops)
        if (Number.isInteger(parsed) && parsed >= 0) settings.trustedProxyHops = parsed
        else warn(" ⚠️  TRUSTED_PROXY_HOPS is not a whole number: the connection's own address is used")
    }

    const ttl = (env.MESSAGE_TTL_HOURS ?? '').trim()
    if (ttl !== '') {
        const parsed = Number(ttl)
        if (Number.isFinite(parsed) && parsed >= 0) settings.messageTtlHours = parsed
        else warn(" ⚠️  MESSAGE_TTL_HOURS is not a number of hours: message expiry left unchanged")
    }

    return settings
}
