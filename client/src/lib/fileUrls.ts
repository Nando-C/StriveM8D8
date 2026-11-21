import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
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

/** A failure this close to when an address lapses is taken to be the address lapsing. */
const LAPSE_LEEWAY_MS = 5000

/**
 * The address to show a file from, once `wanted` (it is near the screen).
 * `failed()` is for when loading from the address did not work: a fresh address is
 * tried, and if that does not work either `broken` says the file cannot be shown here.
 * (An address that fails once its time is up has lapsed — they last minutes, and a
 * video can be watched for longer: that says nothing against the file.)
 *
 * One file per use: a component that goes from one file to another must be keyed by the file.
 */
export const useFileUrl = (fileId: string, wanted: boolean) => {
  const [url, setUrl] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [broken, setBroken] = useState(false)
  const failures = useRef(0)
  /** Until when the address in use is good; null while there is none. */
  const until = useRef<number | null>(null)

  useEffect(() => {
    if (!wanted || broken) return
    let current = true
    void fileUrl(fileId).then(found => {
      if (!current) return
      if (found === null) return setBroken(true)
      // (Its own life, as the server gave it — however long ago, and whoever asked.)
      until.current = known.get(fileId)?.expiresAt ?? Date.now()
      setUrl(found)
    })
    return () => {
      current = false
    }
  }, [fileId, wanted, attempt, broken])

  const failed = useCallback(() => {
    // (Reported again for an address already given up: counted once.)
    if (until.current === null) return
    if (Date.now() >= until.current - LAPSE_LEEWAY_MS) failures.current = 0
    until.current = null
    forgetFileUrl(fileId)
    // Nothing is shown from the dead address while the fresh one is fetched.
    setUrl(null)
    failures.current += 1
    if (failures.current > 1) setBroken(true)
    else setAttempt(tried => tried + 1)
  }, [fileId])

  return { url, broken, failed }
}

/**
 * The same for sound and video, with what its element needs (`media`): when the address
 * lapses while it is being played, it carries on from where it was with a fresh one.
 */
export const useMediaUrl = (fileId: string, wanted: boolean) => {
  const { url, broken, failed } = useFileUrl(fileId, wanted)
  const resume = useRef<{ at: number; playing: boolean } | null>(null)

  const onError = useCallback((event: SyntheticEvent<HTMLMediaElement>) => {
    const element = event.currentTarget
    if (element.currentTime > 0) resume.current = { at: element.currentTime, playing: !element.paused && !element.ended }
    failed()
  }, [failed])

  const onLoadedMetadata = useCallback((event: SyntheticEvent<HTMLMediaElement>) => {
    const from = resume.current
    if (from === null) return
    resume.current = null
    const element = event.currentTarget
    element.currentTime = from.at
    if (from.playing) void element.play().catch(() => {})
    // (Paused when its address lapsed: it does not start by itself, whatever the element would do.)
    else element.pause()
  }, [])

  return { url, broken, media: { onError, onLoadedMetadata } }
}
