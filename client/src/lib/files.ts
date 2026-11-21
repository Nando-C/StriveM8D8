import type { Attachment } from '@/types/protocol'

// What a file is, as far as showing it goes. Decided by its declared type — and only for
// types browsers can show: anything else (HEIC from a phone, say) is a file to download,
// never a broken picture. (QuickTime is what phones and screen recordings produce; most
// browsers play it, and one that cannot falls back to offering the download.)

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'file'

const IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
const VIDEOS = new Set(['video/mp4', 'video/webm', 'video/quicktime'])
const AUDIO = new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac'])

export const kindOf = (type: string): FileKind =>
  IMAGES.has(type) ? 'image'
    : VIDEOS.has(type) ? 'video'
      : AUDIO.has(type) ? 'audio'
        : type === 'application/pdf' ? 'pdf'
          : 'file'

/** Pictures and videos: what the viewer steps through. */
export const isMedia = (file: Pick<Attachment, 'type'>) => {
  const kind = kindOf(file.type)
  return kind === 'image' || kind === 'video'
}

const UNITS = ['B', 'kB', 'MB', 'GB']

/** A size as people say it: "340 kB", "2.4 MB". */
export const formatBytes = (bytes: number) => {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`
}

/** "1:05", "1:02:03". */
export const formatDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000)
  const parts = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
  const [hours, minutes, rest] = parts
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * How many files one message can carry from this client. The server takes ten in a
 * message, but lets an account hold only five uploads that are waiting to be sent — and
 * every file of a message waits until the message goes.
 */
export const MAX_FILES_AT_ONCE = 5

/** A browser gives no type for a file it does not recognise. */
export const typeOf = (file: { type: string }) => (file.type === '' ? 'application/octet-stream' : file.type.toLowerCase())
