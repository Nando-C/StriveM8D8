import { kindOf, typeOf } from '@/lib/files'

// What is worked out about a file before it is uploaded, in the browser: a picture's or
// video's shape (so its bubble has the right size before anything has loaded), a tiny
// blurred preview to fill that shape meanwhile, how long sound or video lasts — and, for
// a very large picture, a smaller copy to send instead.
//
// Every step here is a courtesy. If the browser cannot do one (an odd format, no canvas),
// the file is simply sent as it is, without that detail.

/** Pictures wider than this are sent smaller, unless the original is asked for. */
export const MAX_IMAGE_WIDTH = 2560
const PLACEHOLDER_WIDTH = 16
// The server takes a preview of at most 1000 characters.
const MAX_PLACEHOLDER_LENGTH = 1000
const METADATA_TIMEOUT_MS = 8000
// Formats a canvas can write back in the same type. (A GIF may be animated; resizing would freeze it.)
const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp'])

export interface PreparedFile {
  /** What is uploaded: the file itself, or a smaller copy of a large picture. */
  blob: Blob
  name: string
  type: string
  size: number
  width?: number
  height?: number
  durationMs?: number
  placeholder?: string
  /** A smaller copy was made: the original could be sent instead. */
  resized: boolean
}

const canvasOf = (width: number, height: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

// A few hundred bytes that say roughly what the picture looks like.
const placeholderOf = (source: CanvasImageSource, width: number, height: number): string | undefined => {
  const small = canvasOf(PLACEHOLDER_WIDTH, Math.max(1, Math.round((PLACEHOLDER_WIDTH * height) / width)))
  const context = small.getContext('2d')
  if (context === null) return undefined
  context.drawImage(source, 0, 0, small.width, small.height)
  for (const [type, quality] of [['image/webp', 0.5], ['image/jpeg', 0.5], ['image/jpeg', 0.2]] as const) {
    const url = small.toDataURL(type, quality)
    if (url.startsWith(`data:${type};base64,`) && url.length <= MAX_PLACEHOLDER_LENGTH) return url
  }
  return undefined
}

const loaded = <Element extends HTMLImageElement | HTMLMediaElement>(element: Element, event: string, url: string) =>
  new Promise<Element>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), METADATA_TIMEOUT_MS)
    element.addEventListener(event, () => {
      clearTimeout(timer)
      resolve(element)
    }, { once: true })
    element.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('could not be read'))
    }, { once: true })
    element.src = url
  })

// (Each of these reads the file from `url`, an address for it good on this page only.)
const prepareImage = async (file: File, url: string, type: string, original: boolean): Promise<Partial<PreparedFile>> => {
  const image = await loaded(new Image(), 'load', url)
  const { naturalWidth: width, naturalHeight: height } = image
  if (width === 0 || height === 0) return {}
  const placeholder = placeholderOf(image, width, height)
  if (original || width <= MAX_IMAGE_WIDTH || !RESIZABLE.has(type)) return { width, height, placeholder }

  const smaller = canvasOf(MAX_IMAGE_WIDTH, Math.round((MAX_IMAGE_WIDTH * height) / width))
  smaller.getContext('2d')?.drawImage(image, 0, 0, smaller.width, smaller.height)
  const shape = { width: smaller.width, height: smaller.height }
  const blob = await new Promise<Blob | null>(resolve => smaller.toBlob(resolve, type, 0.9))
  // (A canvas this size holds tens of megabytes: let go of at once, not whenever the browser gets to it.)
  smaller.width = 0
  smaller.height = 0
  // (Not worth it if the copy came out no smaller.)
  if (blob === null || blob.type !== type || blob.size >= file.size) return { width, height, placeholder }
  return { blob, size: blob.size, ...shape, placeholder, resized: true }
}

const prepareVideo = async (url: string): Promise<Partial<PreparedFile>> => {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  await loaded(video, 'loadeddata', url)
  const { videoWidth: width, videoHeight: height } = video
  const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined
  if (width === 0 || height === 0) return { durationMs }
  return { width, height, durationMs, placeholder: placeholderOf(video, width, height) }
}

const prepareAudio = async (url: string): Promise<Partial<PreparedFile>> => {
  const audio = await loaded(new Audio(), 'loadedmetadata', url)
  return Number.isFinite(audio.duration) ? { durationMs: Math.round(audio.duration * 1000) } : {}
}

/** Measures a file — and, unless `original`, makes a very large picture smaller. Never fails. */
export const prepareFile = async (file: File, { original = false } = {}): Promise<PreparedFile> => {
  const type = typeOf(file)
  const plain: PreparedFile = { blob: file, name: file.name, type, size: file.size, resized: false }
  const kind = kindOf(type)
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return plain
  let url: string | undefined
  try {
    url = URL.createObjectURL(file)
    const found =
      kind === 'image' ? await prepareImage(file, url, type, original)
        : kind === 'video' ? await prepareVideo(url)
          : await prepareAudio(url)
    return { ...plain, ...found }
  } catch {
    return plain
  } finally {
    if (url !== undefined) URL.revokeObjectURL(url)
  }
}
