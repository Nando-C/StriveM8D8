import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_FILES_AT_ONCE, formatBytes, kindOf, typeOf } from '@/lib/files'
import { prepareFile } from '@/lib/prepareFile'
import { putFile } from '@/lib/putFile'
import { ask } from '@/lib/request'
import type { Attachment } from '@/types/protocol'

// The files chosen for the message being written. Each is measured, uploaded straight
// away — so that sending the message is instant — and shown as a chip meanwhile.

export type DraftStatus = 'preparing' | 'uploading' | 'ready' | 'failed'

export interface DraftFile {
  key: string
  name: string
  type: string
  /** Of what will be sent, once that is known; until then, of the file as chosen. */
  size: number
  status: DraftStatus
  /** How much has been uploaded, 0 to 1. */
  progress: number
  error?: string
  /** A large picture is being sent smaller: the original can be asked for instead. */
  resized: boolean
  original: boolean
  /** Once uploaded: the file as the message will carry it. */
  attachment?: Attachment
  /** A picture or a video: an address, good on this page only, to show it from before it is sent. */
  preview?: string
}

// The file as chosen, shown straight from the device: nothing is fetched for it.
const previewOf = (file: File): string | undefined => {
  const kind = kindOf(typeOf(file))
  if (kind !== 'image' && kind !== 'video') return undefined
  try {
    return URL.createObjectURL(file)
  } catch {
    return undefined
  }
}

interface Options {
  conversationId: string
  /** The largest file the server takes; `undefined` if it has not said. */
  maxFileBytes: number | undefined
}

// What a chip needs besides what it shows: the file itself, a way to stop its upload,
// and — once it is uploaded — the place it holds on the server.
interface Held {
  file: File
  stop: AbortController
  preview?: string
  fileId?: string
}

const giveBack = (fileId: string) => void ask('cancelUpload', { fileId })

/** Stops a chip's upload; what it has uploaded already is not going to be sent, and its place is given back. */
const halt = (entry: Held) => {
  entry.stop.abort()
  if (entry.fileId !== undefined) giveBack(entry.fileId)
  entry.fileId = undefined
}

const revoke = ({ preview }: Held) => {
  if (preview !== undefined) URL.revokeObjectURL(preview)
}

export const useDraftFiles = ({ conversationId, maxFileBytes }: Options) => {
  const [drafts, setDrafts] = useState<DraftFile[]>([])
  /** Why some of the files just chosen were not taken. */
  const [notice, setNotice] = useState<string | null>(null)
  const held = useRef(new Map<string, Held>())

  const update = useCallback((key: string, change: Partial<DraftFile>) => {
    setDrafts(current => current.map(draft => (draft.key === key ? { ...draft, ...change } : draft)))
  }, [])

  const start = useCallback(async (key: string, original: boolean) => {
    const entry = held.current.get(key)
    if (entry === undefined) return
    const stop = new AbortController()
    entry.stop = stop
    const stillWanted = () => !stop.signal.aborted && held.current.get(key) === entry
    update(key, { status: 'preparing', progress: 0, error: undefined, attachment: undefined, original })

    const prepared = await prepareFile(entry.file, { original })
    if (!stillWanted()) return
    update(key, { size: prepared.size, resized: prepared.resized })
    if (maxFileBytes !== undefined && prepared.size > maxFileBytes) {
      update(key, { status: 'failed', error: `Too large — a file can be at most ${formatBytes(maxFileBytes)}` })
      return
    }

    const { blob, resized: _resized, ...described } = prepared
    const reserved = await ask('requestUpload', { conversationId, ...described })
    if (!stillWanted()) {
      if (reserved.ok) giveBack(reserved.fileId)
      return
    }
    if (!reserved.ok) {
      update(key, { status: 'failed', error: reserved.message })
      return
    }
    update(key, { status: 'uploading' })
    // (Shown in whole percents: told only when that changes.)
    let shown = 0
    const stored = await putFile(reserved.uploadUrl, reserved.headers, blob, {
      signal: stop.signal,
      onProgress: progress => {
        const percent = Math.round(progress * 100)
        if (percent === shown || !stillWanted()) return
        shown = percent
        update(key, { progress })
      },
    })
    if (!stillWanted() || !stored) {
      // Its place is given back, whether it was stopped or it failed.
      giveBack(reserved.fileId)
      if (stillWanted()) update(key, { status: 'failed', error: 'The upload did not finish' })
      return
    }
    entry.fileId = reserved.fileId
    const { name, type, size, width, height, durationMs, placeholder } = prepared
    update(key, {
      status: 'ready',
      progress: 1,
      attachment: {
        id: reserved.fileId, name, type, size,
        ...(width !== undefined && height !== undefined ? { width, height } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(placeholder === undefined ? {} : { placeholder }),
      },
    })
  }, [conversationId, maxFileBytes, update])

  /** Takes as many of `files` as there is room for, and starts uploading them. */
  const add = useCallback((files: File[]) => {
    if (files.length === 0) return
    const room = Math.max(0, MAX_FILES_AT_ONCE - held.current.size)
    const taken = files.slice(0, room)
    setNotice(taken.length < files.length ? `A message can carry ${MAX_FILES_AT_ONCE} files: the rest were left out` : null)
    const added = taken.map(file => {
      const key = crypto.randomUUID()
      const preview = previewOf(file)
      held.current.set(key, { file, stop: new AbortController(), preview })
      return { key, name: file.name, type: typeOf(file), size: file.size, status: 'preparing' as const, progress: 0, resized: false, original: false, preview }
    })
    setDrafts(current => [...current, ...added])
    for (const draft of added) void start(draft.key, false)
  }, [start])

  const remove = useCallback((key: string) => {
    const entry = held.current.get(key)
    if (entry !== undefined) {
      halt(entry)
      revoke(entry)
      held.current.delete(key)
    }
    setDrafts(current => current.filter(draft => draft.key !== key))
    setNotice(null)
  }, [])

  /** Uploads a file again: after a failure, or to send the original instead of the smaller copy (or back). */
  const restart = useCallback((key: string, original: boolean) => {
    const entry = held.current.get(key)
    if (entry !== undefined) halt(entry)
    void start(key, original)
  }, [start])

  /** The message went: its files are the message's now, and the chips are done with. */
  const sent = useCallback(() => {
    for (const entry of held.current.values()) revoke(entry)
    held.current.clear()
    setDrafts([])
    setNotice(null)
  }, [])

  // Leaving the conversation with files not sent: nothing is left uploading or reserved.
  useEffect(() => {
    const entries = held.current
    return () => {
      for (const entry of entries.values()) {
        halt(entry)
        revoke(entry)
      }
    }
  }, [])

  const ready = drafts.every(draft => draft.status === 'ready')
  return {
    drafts,
    notice,
    /** Every chosen file is uploaded: the message can go. */
    ready,
    /** No room for another file. */
    full: drafts.length >= MAX_FILES_AT_ONCE,
    attachments: ready ? drafts.flatMap(draft => (draft.attachment === undefined ? [] : [draft.attachment])) : [],
    add,
    remove,
    restart,
    sent,
  }
}
