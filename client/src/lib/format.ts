const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** "Today", "Yesterday", or a full date — the label for a day's worth of messages. */
export const formatDay = (timestamp: number, now = new Date()) => {
  const day = new Date(timestamp)
  if (sameDay(day, now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(day, yesterday)) return 'Yesterday'
  return day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

export const isSameDay = (a: number, b: number) => sameDay(new Date(a), new Date(b))

export const initials = (username: string) => username.slice(0, 2).toUpperCase()

// Full class names, spelled out so Tailwind can see them.
const AVATAR_COLOURS = [
  'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200',
]

/** The same username always gets the same avatar colour. */
export const avatarColour = (username: string) => {
  let hash = 0
  for (const character of username) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length]
}
