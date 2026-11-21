import { useCallback, useEffect, useRef, useState } from 'react'
import { ask } from '@/lib/request'

// The address a file can be fetched from is given out by the server for a few minutes at
// a time, to whoever may see the file. Asked for when a file is about to be shown, kept
// until shortly before it lapses, and asked for again if loading from it fails.

/** Stop using an address this long before it lapses: a load that starts then would not finish. */
const MARGIN_MS = 30_000

const known = new Map<string, { url: string; expiresAt: number }>()
const asking = new Map<string, Promise<string | null>>()

/** An address for showing the file, or null if the server gives none. */
export const fileUrl = (fileId: string): Promise<string | null> => {
  const held = known.get(fileId)
  if (held !== undefined && held.expiresAt - MARGIN_MS > Date.now()) return Promise.resolve(held.url)
  const underWay = asking.get(fileId)
  if (underWay !== undefined) return underWay
  const request = ask('getFileUrl', { fileId }).then(answer => {
    asking.delete(fileId)
    if (!answer.ok) return null
    known.set(fileId, { url: answer.url, expiresAt: Date.now() + answer.expiresInSeconds * 1000 })
    return answer.url
  })
  asking.set(fileId, request)
  return request
}

/** The address held for a file is no good (loading from it failed): the next one is asked for afresh. */
export const forgetFileUrl = (fileId: string) => {
  known.delete(fileId)
}

/** For tests, and for whoever logs in next on this page. */
export const forgetFileUrls = () => {
  known.clear()
  asking.clear()
}

/** An address that saves the file rather than showing it. Never kept: used at once. */
export const downloadUrl = async (fileId: string): Promise<string | null> => {
  const answer = await ask('getFileUrl', { fileId, download: true })
  return answer.ok ? answer.url : null
}

/** Starts the browser saving a file. Resolves to whether it could. */
export const saveFile = async (fileId: string): Promise<boolean> => {
  const url = await downloadUrl(fileId)
  if (url === null) return false
  const link = document.createElement('a')
  link.href = url
  // (The server names the file and says it is to be saved; this covers browsers that ask.)
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  return true
}

/**
 * The address to show a file from, once `wanted` (it is near the screen).
 * `failed()` is for when loading from the address did not work: one fresh address is
 * tried, and after that `broken` says the file cannot be shown here.
 */
export const useFileUrl = (fileId: string, wanted: boolean) => {
  const [url, setUrl] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [broken, setBroken] = useState(false)
  const failures = useRef(0)

  useEffect(() => {
    if (!wanted || broken) return
    let current = true
    void fileUrl(fileId).then(found => {
      if (!current) return
      if (found === null) setBroken(true)
      else setUrl(found)
    })
    return () => {
      current = false
    }
  }, [fileId, wanted, attempt, broken])

  const failed = useCallback(() => {
    forgetFileUrl(fileId)
    setUrl(null)
    failures.current += 1
    if (failures.current > 1) setBroken(true)
    else setAttempt(tried => tried + 1)
  }, [fileId])

  return { url, broken, failed }
}
