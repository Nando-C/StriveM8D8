// A position in a conversation: a message's timestamp and its id, as { ts, id }.
//
// Read positions, delivery positions and the history cursor are all positions. They are
// ordered exactly as history is sorted — by time, then by id — because a timestamp alone
// cannot tell apart two messages saved in the same millisecond: one of them would be
// skipped or repeated at a page boundary, or miscounted as read.
//
// `null` stands for "before everything". The client has the same helper
// (client/src/lib/positions.ts); a test on each side checks the same cases.

export const comparePositions = (a, b) => {
    if (a == null || b == null) return (a == null ? 0 : 1) - (b == null ? 0 : 1)
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
}

export const laterPosition = (a, b) => (comparePositions(a, b) >= 0 ? a : b)

export const isPosition = value =>
    typeof value === 'object' && value !== null &&
    Number.isSafeInteger(value.ts) && value.ts >= 0 &&
    typeof value.id === 'string' && /^[0-9a-f]{24}$/.test(value.id)

/** The position of a stored message. */
export const positionOf = message => ({ ts: message.createdAt.getTime(), id: message._id.toString() })

/** A MongoDB condition on messages: strictly after `position` (everything, for null). */
export const afterPosition = position => (position == null ? {} : {
    $or: [
        { createdAt: { $gt: new Date(position.ts) } },
        { createdAt: new Date(position.ts), _id: { $gt: position.id } },
    ],
})

/** A MongoDB condition on messages: strictly before `position`. */
export const beforePosition = position => ({
    $or: [
        { createdAt: { $lt: new Date(position.ts) } },
        { createdAt: new Date(position.ts), _id: { $lt: position.id } },
    ],
})
