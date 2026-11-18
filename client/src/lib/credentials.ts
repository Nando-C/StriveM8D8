// What the server accepts as a username and a password, for the forms that ask for them.

export const USERNAME_HINT = 'Up to 30 letters, digits, hyphens or underscores.'
export const PASSWORD_HINT = '8 to 128 characters. Anything goes — a few words work well.'
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128

export const isPassword = (value: string) => value.length >= MIN_PASSWORD_LENGTH && value.length <= MAX_PASSWORD_LENGTH

/** The attributes every username input shares: what it accepts, and no "helpful" rewriting. */
export const usernameInput = { autoCapitalize: 'none', spellCheck: false, maxLength: 30 } as const

/** The attributes of an input for an invitation code. */
export const invitationInput = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false, maxLength: 100 } as const

/** Password inputs differ only in which password a password manager should offer. */
export const passwordInput = (autoComplete: 'current-password' | 'new-password') =>
  ({ type: 'password', autoComplete, maxLength: MAX_PASSWORD_LENGTH }) as const
