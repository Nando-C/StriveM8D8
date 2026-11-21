import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { FileCard } from '@/components/files/FileCard'
import { formatDuration, kindOf } from '@/lib/files'
import { useFileUrl, useMediaUrl } from '@/lib/fileUrls'
import { useNearViewport } from '@/lib/useNearViewport'
import { cn } from '@/lib/utils'
import type { Attachment } from '@/types/protocol'

/** How many pictures of one message are shown; the last tile says how many more there are. */
const MAX_TILES = 4

interface TileProps {
  file: Attachment
  /** Alone in its message: shown at its own shape. Otherwise a square tile. */
  alone: boolean
  /** How many more pictures the message has than are shown, on the last tile. */
  more: number
  onOpen: (fileId: string) => void
  /** It cannot be shown after all: the message falls back to a file card for it. */
  onBroken: (fileId: string) => void
  /** The message has been saved: only then does the server give out addresses for its files. */
  saved: boolean
}

// Asking for a moment of a video makes a browser show that frame as a still; given none,
// several (Safari above all) show nothing until it is played. Never sent to the server.
const FIRST_FRAME = '#t=0.001'

const shapeOf = (file: Attachment) =>
  file.width !== undefined && file.height !== undefined ? Math.min(Math.max(file.width / file.height, 0.6), 2.4) : 4 / 3

const placeholderOf = (file: Attachment) => (file.placeholder === undefined ? undefined : `url("${file.placeholder}")`)

// One picture, as a tile that opens the viewer. Its box has the picture's shape from the
// start, filled with the blurred preview, so nothing moves when it loads.
function ImageTile({ file, alone, more, onOpen, onBroken, saved }: TileProps) {
  const tile = useRef<HTMLButtonElement>(null)
  const near = useNearViewport(tile)
  const { url, broken, failed } = useFileUrl(file.id, near && saved)
  useEffect(() => {
    if (broken) onBroken(file.id)
  }, [broken, file.id, onBroken])

  return (
    <button
      ref={tile}
      type="button"
      data-attachment="image"
      onClick={() => onOpen(file.id)}
      aria-label={`View ${file.name}`}
      style={{ aspectRatio: alone ? String(shapeOf(file)) : '1', backgroundImage: placeholderOf(file) }}
      className={cn(
        'relative block overflow-hidden rounded-xl bg-muted bg-cover bg-center outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        alone ? 'w-72 max-w-full' : 'w-full',
      )}
    >
      {url !== null && (
        <img src={url} alt={file.name} decoding="async" onError={failed} className="absolute inset-0 size-full object-cover" />
      )}
      {more > 0 && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-xl font-medium text-white">+{more}</span>
      )}
    </button>
  )
}

interface PlayerProps {
  file: Attachment
  own: boolean
  onBroken: (fileId: string) => void
  saved: boolean
}

/** A video, played where it is — loaded only as far as its first frame and length until then — and openable full-size. */
function VideoPlayer({ file, own: _own, onOpen, onBroken, saved }: PlayerProps & { onOpen: (fileId: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const near = useNearViewport(box)
  const { url, broken, media } = useMediaUrl(file.id, near && saved)
  useEffect(() => {
    if (broken) onBroken(file.id)
  }, [broken, file.id, onBroken])

  return (
    <div
      ref={box}
      data-attachment="video"
      style={{ aspectRatio: String(shapeOf(file)), backgroundImage: placeholderOf(file) }}
      className="relative w-72 max-w-full overflow-hidden rounded-xl bg-black bg-cover bg-center"
    >
      {url !== null && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- a file someone sent: there are no captions to offer
        <video controls playsInline preload="metadata" src={`${url}${FIRST_FRAME}`} aria-label={file.name} {...media} className="absolute inset-0 size-full" />
      )}
      <button
        type="button"
        onClick={() => onOpen(file.id)}
        aria-label={`View ${file.name} full size`}
        className="absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-full bg-black/55 text-white outline-none hover:bg-black/75 focus-visible:ring-3 focus-visible:ring-white/70"
      >
        <Maximize2 aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  )
}

/** Sound, played where it is. Loaded only as far as knowing how long it is, until it is played. */
function AudioPlayer({ file, own, onBroken, saved }: PlayerProps) {
  const box = useRef<HTMLDivElement>(null)
  const near = useNearViewport(box)
  const { url, broken, media } = useMediaUrl(file.id, near && saved)
  useEffect(() => {
    if (broken) onBroken(file.id)
  }, [broken, file.id, onBroken])

  return (
    <div ref={box} data-attachment="audio" className="flex w-72 max-w-full flex-col gap-1">
      <span className={cn('truncate text-xs', own ? 'opacity-90' : 'text-muted-foreground')}>
        {file.name}
        {file.durationMs !== undefined && ` · ${formatDuration(file.durationMs)}`}
      </span>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a file someone sent: there are no captions to offer */}
      <audio controls preload="metadata" src={url ?? undefined} aria-label={file.name} {...media} className="h-10 w-full" />
    </div>
  )
}

interface AttachmentsProps {
  files: Attachment[]
  own: boolean
  /** Opens a picture, a video or a PDF in the viewer. */
  onOpen: (fileId: string) => void
  /** The message is saved (not still being sent, not failed): its files can be fetched. */
  saved: boolean
}

/**
 * The files of one message: pictures as a grid, video and sound as players, and
 * everything else — including anything this browser turns out unable to show — as a
 * card to download.
 */
export const Attachments = memo(function Attachments({ files, own, onOpen, saved }: AttachmentsProps) {
  // Files that could not be loaded as what their type says (an odd encoding, a damaged file).
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set())
  const onBroken = useCallback((fileId: string) => setBroken(current => new Set(current).add(fileId)), [])
  const shown = (file: Attachment) => (broken.has(file.id) ? 'file' : kindOf(file.type))
  const of = (...kinds: string[]) => files.filter(file => kinds.includes(shown(file)))
  const images = of('image')
  const tiles = images.slice(0, MAX_TILES)

  return (
    <div className="flex max-w-full flex-col gap-1.5">
      {tiles.length > 0 && (
        <div className={cn('grid gap-1', tiles.length === 1 ? 'grid-cols-1' : 'w-72 max-w-full grid-cols-2')}>
          {tiles.map((file, index) => (
            <ImageTile
              key={file.id}
              file={file}
              alone={tiles.length === 1}
              more={index === MAX_TILES - 1 ? images.length - MAX_TILES : 0}
              onOpen={onOpen}
              onBroken={onBroken}
              saved={saved}
            />
          ))}
        </div>
      )}
      {of('video').map(file => <VideoPlayer key={file.id} file={file} own={own} onOpen={onOpen} onBroken={onBroken} saved={saved} />)}
      {of('audio').map(file => <AudioPlayer key={file.id} file={file} own={own} onBroken={onBroken} saved={saved} />)}
      {of('pdf', 'file').map(file => (
        <FileCard key={file.id} file={file} own={own} onOpen={shown(file) === 'pdf' ? () => onOpen(file.id) : undefined} />
      ))}
    </div>
  )
})
