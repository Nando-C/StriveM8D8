import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Guest reservations, device sessions and invitation codes are 32 random bytes. A secret
// with that much entropy cannot be guessed, so only its SHA-256 is stored and a slow
// password hash would add nothing. Passwords and recovery codes are a different matter:
// see passwords.js.
export const newSecret = () => randomBytes(32).toString('base64url')

export const fingerprint = secret => createHash('sha256').update(String(secret)).digest('hex')

/** Compares two strings without revealing, through timing, where they differ. */
export const sameString = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/** The longest secret a client may send: anything longer is not one of ours. */
export const MAX_SECRET_LENGTH = 100

export const isSecret = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_LENGTH

// 32 symbols, none easily mistaken for another: no I, O, 0 or 1.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const RECOVERY_LENGTH = 20

/** A recovery code as shown to its owner: 20 symbols (100 bits) in four groups. */
export const newRecoveryCode = () => {
    // 32 symbols divide 256 evenly, so taking each byte modulo 32 is unbiased.
    const symbols = Array.from(randomBytes(RECOVERY_LENGTH), byte => RECOVERY_ALPHABET[byte % 32])
    return symbols.join('').replace(/(.{5})(?=.)/g, '$1-')
}

/** The form a recovery code is hashed in, so that case, spaces and hyphens do not matter. */
export const normaliseRecoveryCode = code => String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')
