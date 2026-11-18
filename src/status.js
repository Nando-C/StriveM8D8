// Status: what a user has chosen to show, and what everyone else is then shown.

export const STATUSES = ['online', 'away', 'dnd', 'invisible']
export const MAX_STATUS_TEXT_LENGTH = 80
/** The longest a status text can be set to clear itself after: a week. */
export const MAX_CLEAR_AFTER_MINUTES = 7 * 24 * 60

export const BOT_STATUS_TEXT = 'I answer every message'

/**
 * What everyone else is shown of a connected user — the one place that decides it.
 *
 * - `null`: nothing. An invisible user is not listed, not announced, and looks to
 *   others exactly like someone who is not connected.
 * - chosen `online`, but idle on every device: shown as `away`.
 * - `away` and `dnd` are shown as chosen, idle or not.
 *
 * `idle` is whether every one of the user's connections reports no activity.
 */
export const publicPresence = ({ status = 'online', statusText = '', idle = false } = {}) => {
    if (status === 'invisible') return null
    return {
        status: status === 'online' && idle ? 'away' : status,
        statusText,
    }
}

/** A status text as it is stored: one line, trimmed, no control characters, at most 80. */
export const cleanStatusText = value =>
    // eslint-disable-next-line no-control-regex
    String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()

export const isStatus = value => typeof value === 'string' && STATUSES.includes(value)
