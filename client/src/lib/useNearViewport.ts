import { useEffect, useState, type RefObject } from 'react'

/**
 * Whether an element has come near the screen — within a screen's height or so. Once it
 * has, it stays so: what was loaded for it is not unloaded again.
 */
export const useNearViewport = (target: RefObject<Element | null>) => {
  // (Where the browser cannot say, everything counts as near.)
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    if (near || target.current === null) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) setNear(true)
      },
      { rootMargin: '600px 0px' },
    )
    observer.observe(target.current)
    return () => observer.disconnect()
  }, [near, target])

  return near
}
