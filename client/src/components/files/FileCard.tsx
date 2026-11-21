import { useState } from 'react'
import { Download, File as FileIcon, FileArchive, FileAudio, FileImage, FileText, FileVideo, LoaderCircle } from 'lucide-react'
import { formatBytes } from '@/lib/files'
import { saveFile } from '@/lib/fileUrls'
import { cn } from '@/lib/utils'
import type { Attachment } from '@/types/protocol'

/** A picture for the kind of file it is. */
function FileTypeIcon({ type }: { type: string }) {
  const look = { 'aria-hidden': true, className: 'size-8 shrink-0 opacity-80' } as const
  if (type.startsWith('image/')) return <FileImage {...look} />
  if (type.startsWith('video/')) return <FileVideo {...look} />
  if (type.startsWith('audio/')) return <FileAudio {...look} />
  if (type === 'application/pdf' || type.startsWith('text/')) return <FileText {...look} />
  if (/zip|compressed|tar|archive/.test(type)) return <FileArchive {...look} />
  return <FileIcon {...look} />
}

interface FileCardProps {
  file: Attachment
  /** On the user's own bubble, which is coloured. */
  own: boolean
  /** For a file that can be looked at here (a PDF): opens it. Otherwise the card only downloads. */
  onOpen?: () => void
}

/** A file that is not shown in the conversation itself: what it is, how big, and a way to get it. */
export function FileCard({ file, own, onOpen }: FileCardProps) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  const download = async () => {
    setState('busy')
    setState((await saveFile(file.id)) ? 'idle' : 'failed')
  }
  const label = (
    <>
      <FileTypeIcon type={file.type} />
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate font-medium">{file.name}</span>
        <span className="text-xs opacity-80">
          {state === 'failed' ? 'Could not be downloaded — try again' : formatBytes(file.size)}
        </span>
      </span>
    </>
  )
  return (
    <div
      data-attachment="file"
      className={cn(
        'flex w-64 max-w-full items-center gap-2 rounded-xl border p-2 text-sm',
        own ? 'border-primary-foreground/25' : 'border-border bg-background/60',
      )}
    >
      {onOpen === undefined ? (
        <span className="flex min-w-0 flex-1 items-center gap-2">{label}</span>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${file.name}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {label}
        </button>
      )}
      <button
        type="button"
        onClick={() => void download()}
        disabled={state === 'busy'}
        aria-label={`Download ${file.name}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-full outline-none hover:bg-foreground/10 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
      >
        {state === 'busy' ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <Download aria-hidden="true" className="size-4" />}
      </button>
    </div>
  )
}
