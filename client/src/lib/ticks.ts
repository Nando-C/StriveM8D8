import type { LocalMessage } from '@/lib/messages'
import { comparePositions } from '@/lib/positions'
import type { ConversationMember, ConversationSummary } from '@/types/protocol'

// How far one of the user's own messages has got: saved, delivered to the other person's
// device, or seen. Nothing is stored per message — it is worked out from where each other
// member stands in the conversation, which the server keeps (and sends) per member.

export type Tick = 'sent' | 'delivered' | 'seen'

export const TICK_LABELS: Record<Tick, string> = { sent: 'Sent', delivered: 'Delivered', seen: 'Seen' }

// In a group the bot reads only what mentions it; counting it would hold every message at one tick.
const BOT_ID = 'demo-bot'

/**
 * Who a message was for: the other members who were already in the conversation when it
 * was sent. Someone added later never had the message in front of them, and must not
 * un-tick it.
 */
export const audienceOf = (message: LocalMessage, summary: ConversationSummary, ownUserId: string): ConversationMember[] => {
  if (message.id === null) return []
  const position = { ts: message.timestamp, id: message.id }
  return summary.members.filter(
    member =>
      member.userId !== ownUserId &&
      !(summary.kind === 'group' && member.userId === BOT_ID) &&
      comparePositions(member.joinedAfter ?? null, position) < 0,
  )
}

const reached = (member: ConversationMember, field: 'deliveredUpTo' | 'readUpTo', message: LocalMessage) =>
  message.id !== null && comparePositions(member[field], { ts: message.timestamp, id: message.id }) >= 0

/** Whoever has read a message has also received it, whatever was recorded. */
const hasReceived = (member: ConversationMember, message: LocalMessage) =>
  reached(member, 'deliveredUpTo', message) || reached(member, 'readUpTo', message)

/**
 * The tick for one of the user's own confirmed messages. With several other members,
 * "delivered" and "seen" mean all of them.
 */
export const tickOf = (message: LocalMessage, summary: ConversationSummary | null, ownUserId: string | null): Tick => {
  if (summary === null || ownUserId === null) return 'sent'
  const audience = audienceOf(message, summary, ownUserId)
  if (audience.length === 0) return 'sent'
  if (audience.every(member => reached(member, 'readUpTo', message))) return 'seen'
  if (audience.every(member => hasReceived(member, message))) return 'delivered'
  return 'sent'
}

/** Who has seen a message and who has only received it — for a group's "seen by" list. */
export const receiptsOf = (message: LocalMessage, summary: ConversationSummary, ownUserId: string) => {
  const audience = audienceOf(message, summary, ownUserId)
  const seenBy = audience.filter(member => reached(member, 'readUpTo', message))
  const deliveredTo = audience.filter(member => !seenBy.includes(member) && hasReceived(member, message))
  return { seenBy: seenBy.map(member => member.username), deliveredTo: deliveredTo.map(member => member.username) }
}
