import type { GroupEvent, NamedUser } from '@/types/protocol'

// What happened to a group arrives as data (`GroupEvent`), never as a sentence: this is
// where it is put into words, from the reader's point of view ("You added bob").

const isNamed = (value: unknown): value is NamedUser =>
  typeof value === 'object' && value !== null &&
  typeof (value as NamedUser).userId === 'string' && typeof (value as NamedUser).username === 'string'

/** The data of a system message, if it is an event this client knows how to word. */
const asGroupEvent = (data: unknown): GroupEvent | null => {
  if (typeof data !== 'object' || data === null) return null
  const event = data as Partial<Record<'event' | 'actor' | 'target' | 'targets' | 'name', unknown>>
  if (!isNamed(event.actor)) return null
  const targets = Array.isArray(event.targets) && event.targets.every(isNamed)
  switch (event.event) {
    case 'created':
      return typeof event.name === 'string' && targets ? (data as GroupEvent) : null
    case 'added':
      return targets ? (data as GroupEvent) : null
    case 'removed':
      return isNamed(event.target) ? (data as GroupEvent) : null
    case 'left':
      return data as GroupEvent
    case 'renamed':
      return typeof event.name === 'string' ? (data as GroupEvent) : null
    default:
      return null
  }
}

/** "ana", "ana and ben", "ana, ben and cy". */
const listed = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/** One line saying what happened, as `ownUserId` reads it. */
export const describeGroupEvent = (data: unknown, ownUserId: string | null): string => {
  const event = asGroupEvent(data)
  // Something a newer server says that this page does not know yet.
  if (event === null) return 'The group changed'
  const own = (user: NamedUser) => user.userId === ownUserId
  const actor = own(event.actor) ? 'You' : event.actor.username
  const object = (user: NamedUser) => (own(user) ? 'you' : user.username)

  switch (event.event) {
    case 'created':
      return `${actor} created the group “${event.name}”`
    case 'added':
      return `${actor} added ${listed(event.targets.map(object))}`
    case 'removed':
      return `${actor} removed ${object(event.target)}`
    case 'left':
      return `${actor} left`
    case 'renamed':
      return `${actor} renamed the group to “${event.name}”`
  }
}

// The server's limits, so that a form does not offer what would be refused.
export const MAX_GROUP_NAME_LENGTH = 50
export const MAX_GROUP_MEMBERS = 20
