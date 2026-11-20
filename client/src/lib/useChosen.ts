import { useState } from 'react'

/**
 * The set a picker edits, and the ways it changes. Only people who can still be picked
 * count as chosen: someone ticked who then drops out of the list (they went offline, or
 * somebody else added them first) is not sent along unseen.
 */
export function useChosen(candidates: { userId: string }[]) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const pickable = new Set(candidates.map(candidate => candidate.userId))
  // (In the order they were ticked: it becomes the order they join in.)
  const chosen: ReadonlySet<string> = new Set([...ticked].filter(userId => pickable.has(userId)))
  const toggle = (userId: string) =>
    setTicked(current => {
      const next = new Set(current)
      if (!next.delete(userId)) next.add(userId)
      return next
    })
  const clear = () => setTicked(new Set())
  return { chosen, toggle, clear }
}
