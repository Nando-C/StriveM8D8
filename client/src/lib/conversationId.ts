// The id of the direct conversation between two users: the same from either side, so
// opening a chat with someone needs no request. It is only ever a name for the
// conversation — the server decides who may use it from its stored members.
//
// The server has the same function (src/conversations.js); a test on each side checks
// the same cases. Sorting must match JavaScript's default (code-unit) order on both.

export const directConversationId = (userIdA: string, userIdB: string): string =>
  `dm:${[userIdA, userIdB].sort().join('::')}`
