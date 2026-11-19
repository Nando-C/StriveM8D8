import type { Message, MessageKind } from '@/types/protocol'

export type MessageStatus = 'sent' | 'pending' | 'failed'

/** One message as the UI shows it, whether it arrived live, from history, or was typed here. */
export interface LocalMessage {
  /** Stable React key: survives the pending → sent transition of the user's own messages. */
  key: string
  /** The server's id. `null` until the server has confirmed the message. */
  id: string | null
  /** The id this client generated when sending. `null` for messages it did not send. */
  clientId: string | null
  /** The author's `userId`. */
  from: string
  /** The author's name when the message was sent. */
  fromName: string
  kind: MessageKind
  text: string
  /** What a system message says happened (see lib/groupEvents.ts). */
  data?: unknown
  timestamp: number
  /** Sent by the logged-in user (from this device or another). */
  own: boolean
  status: MessageStatus
  /** Why a failed message failed. */
  error?: string
  /**
   * When this client saw the message arrive or sent it (its own clock), or `null` for a
   * message that came from history. Only used to decide whether it animates in.
   */
  arrivedAt: number | null
}

/** A text on one line: what a preview of it starts from. */
export const oneLine = (text: string) => text.trim().replace(/\s+/g, ' ')

const PREVIEW_LENGTH = 80

/** The text shown under a conversation's name in the list, cut as the server cuts it. */
export const previewOf = (text: string) => {
  const flat = oneLine(text)
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat
}

export const UNCONFIRMED = 'Delivery unconfirmed: the connection was lost'

/** A message from the server — live (`arrivedAt` set) or from history (`null`). */
export const fromServer = (message: Message, ownUserId: string, arrivedAt: number | null): LocalMessage => {
  const own = message.from === ownUserId
  return {
    // The user's own messages keep the key they had while pending (their clientId).
    key: own && message.clientId !== null ? message.clientId : message.id,
    id: message.id,
    clientId: message.clientId,
    from: message.from,
    fromName: message.fromName,
    kind: message.kind,
    text: message.text ?? '',
    ...(message.data === undefined ? {} : { data: message.data }),
    timestamp: message.timestamp,
    own,
    status: 'sent',
    arrivedAt,
  }
}

const byTimeThenId = (a: LocalMessage, b: LocalMessage) =>
  a.timestamp - b.timestamp || (a.id ?? '').localeCompare(b.id ?? '')

/**
 * Merges server-confirmed messages into a conversation. Never appends or replaces blindly:
 *
 * - confirmed messages are unique by server id, so a message received live and then again
 *   in history appears once (and one that is already there keeps its place and its key);
 * - the user's unconfirmed messages (pending or failed, no server id yet) are kept, after
 *   the confirmed ones — unless a confirmed message carries the same clientId, in which
 *   case that local item *is* that message and the confirmed one takes its place. That is
 *   what rescues a send whose acknowledgement was lost.
 */
export const mergeConfirmed = (existing: LocalMessage[], incoming: LocalMessage[]): LocalMessage[] => {
  const confirmed = new Map<string, LocalMessage>()
  for (const message of existing) {
    if (message.id !== null) confirmed.set(message.id, message)
  }
  for (const message of incoming) {
    // A copy from history must not replace one that arrived live: it would lose `arrivedAt`.
    if (message.id !== null && !(confirmed.has(message.id) && message.arrivedAt === null)) confirmed.set(message.id, message)
  }

  const confirmedClientIds = new Set<string>()
  for (const message of confirmed.values()) {
    if (message.clientId !== null) confirmedClientIds.add(message.clientId)
  }

  const unconfirmed = existing.filter(
    message => message.id === null && !(message.clientId !== null && confirmedClientIds.has(message.clientId)),
  )

  return [...[...confirmed.values()].sort(byTimeThenId), ...unconfirmed]
}
