import { useState } from 'react'

/** The set a picker edits, and the one way it changes. */
export function useChosen() {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (userId: string) =>
    setChosen(current => {
      const next = new Set(current)
      if (!next.delete(userId)) next.add(userId)
      return next
    })
  return { chosen, toggle }
}
