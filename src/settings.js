// Everything that differs between deployments, in one place. `createApp()` takes these as
// options (so tests can run several configurations in one process) and `src/index.js`
// reads them from the environment.

export const SIGNUP_MODES = ['open', 'invite', 'closed']
export const MEMBER_DIRECTORIES = ['online', 'all']
export const FILE_STORAGES = ['s3', 'local']

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
    /** Who accounts are shown under People: whoever is `online`, or `all` accounts. */
    memberDirectory: 'online',
    /** How many proxies in front of the server may be believed about the client's address. */
    trustedProxyHops: 0,
    /** Serves GET /proxy-check, for working out `trustedProxyHops` on a new host. Off unless asked for. */
    proxyCheck: false,
    /** undefined: not configured. 0: nothing expires. Positive: hours until data expires. */
    messageTtlHours: undefined,
    /** How long a browser has to confirm it received the secret that reserves a new guest name. */
    reservationAckTimeoutMs: 10_000,
    /** How long a device has to acknowledge a message before it does not count as delivered there. */
    deliveryAckTimeoutMs: 10_000,
    /** scrypt parameters for new password hashes; undefined uses the production default. */
    passwordParams: undefined,
    /** Where uploaded files are kept: 's3', 'local', or null — no file sharing at all. */
    fileStorage: null,
    /** The folder the local driver keeps files in. */
    localStorageDir: 'uploads',
    /** The bucket and credentials of the s3 driver: { endpoint, region, bucket, accessKeyId, secretAccessKey }. */
    s3: null,
    /** The largest single file, in megabytes. */
    uploadMaxFileMb: 25,
    /** How much one account may upload in 24 hours. */
    uploadMaxUserMbPerDay: 200,
    /** The same, for everything from one client address. undefined: four times the per-user figure. 0: no such limit. */
    uploadMaxAddressMbPerDay: undefined,
    /** How much may be stored in all. Beyond it, uploads are refused for everyone. */
    uploadMaxTotalMb: 2000,
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
    if (!MEMBER_DIRECTORIES.includes(settings.memberDirectory)) {
        throw new TypeError(`memberDirectory must be one of ${MEMBER_DIRECTORIES.join(', ')}`)
    }
    if (settings.fileStorage !== null && !FILE_STORAGES.includes(settings.fileStorage)) {
        throw new TypeError(`fileStorage must be one of ${FILE_STORAGES.join(', ')}, or null`)
    }
    if (settings.fileStorage === 's3' && !(settings.s3?.bucket && settings.s3.accessKeyId && settings.s3.secretAccessKey)) {
        throw new TypeError('fileStorage "s3" needs s3.bucket, s3.accessKeyId and s3.secretAccessKey')
    }
    settings.uploadMaxAddressMbPerDay ??= settings.uploadMaxUserMbPerDay * 4
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
        proxyCheck: env.PROXY_CHECK === 'true',
    }

    const mode = (env.SIGNUP_MODE ?? '').trim()
    if (mode === '' || SIGNUP_MODES.includes(mode)) {
        settings.signupMode = mode || 'open'
    } else {
        // An unreadable value must not open a deployment that was meant to be restricted.
        warn(" ⚠️  SIGNUP_MODE is not one of open, invite, closed: sign-up is closed")
        settings.signupMode = 'closed'
    }

    const directory = (env.MEMBER_DIRECTORY ?? '').trim()
    if (MEMBER_DIRECTORIES.includes(directory)) settings.memberDirectory = directory
    // An unreadable value lists nobody extra, which is the private side to err on.
    else if (directory !== '') warn(" ⚠️  MEMBER_DIRECTORY is not one of online, all: only people who are online are listed")

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

    // File sharing is off unless a place to keep the files is named — and fully described.
    const storage = (env.FILE_STORAGE ?? '').trim()
    if (storage === 'local') {
        settings.fileStorage = 'local'
        if (env.FILE_STORAGE_DIR) settings.localStorageDir = env.FILE_STORAGE_DIR
    } else if (storage === 's3') {
        const s3 = {
            endpoint: env.S3_ENDPOINT || undefined,
            region: env.S3_REGION || 'auto',
            bucket: env.S3_BUCKET,
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        }
        if (s3.bucket && s3.accessKeyId && s3.secretAccessKey) Object.assign(settings, { fileStorage: 's3', s3 })
        else warn(" ⚠️  FILE_STORAGE is s3 but S3_BUCKET, S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY is missing: file sharing is off")
    } else if (storage !== '') {
        warn(" ⚠️  FILE_STORAGE is not one of s3, local: file sharing is off")
    }

    // Megabytes. A limit that cannot be read keeps its default rather than becoming no limit.
    const megabytes = (name, key, { zeroAllowed = false } = {}) => {
        const raw = (env[name] ?? '').trim()
        if (raw === '') return
        const parsed = Number(raw)
        if (Number.isFinite(parsed) && (parsed > 0 || (zeroAllowed && parsed === 0))) settings[key] = parsed
        else warn(` ⚠️  ${name} is not a number of megabytes: the default is used`)
    }
    megabytes('UPLOAD_MAX_FILE_MB', 'uploadMaxFileMb')
    megabytes('UPLOAD_MAX_USER_MB_PER_DAY', 'uploadMaxUserMbPerDay')
    megabytes('UPLOAD_MAX_ADDRESS_MB_PER_DAY', 'uploadMaxAddressMbPerDay', { zeroAllowed: true })
    megabytes('UPLOAD_MAX_TOTAL_MB', 'uploadMaxTotalMb')

    return settings
}
