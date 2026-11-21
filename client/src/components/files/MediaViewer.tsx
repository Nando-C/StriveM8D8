import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { formatBytes, kindOf } from '@/lib/files'
import { saveFile, useFileUrl } from '@/lib/fileUrls'
import type { Attachment } from '@/types/protocol'

interface MediaViewerProps {
  /** The file being looked at. */
  file: Attachment
  /** The conversation's pictures and videos, oldest first: what the arrows step through. */
  gallery: Attachment[]
  onShow: (fileId: string) => void
  onClose: () => void
}

/** A picture, a video or a PDF at full size, over the conversation. */
export function MediaViewer({ file, gallery, onShow, onClose }: MediaViewerProps) {
  const kind = kindOf(file.type)
  const { url, broken, failed } = useFileUrl(file.id, true)
  const [saving, setSaving] = useState(false)
  const at = gallery.findIndex(candidate => candidate.id === file.id)
  const previous = at > 0 ? gallery[at - 1] : undefined
  const next = at !== -1 && at < gallery.length - 1 ? gallery[at + 1] : undefined

  // The arrow keys step through the pictures and videos — unless they are being used
  // for something else (a video's own controls have the focus).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLMediaElement) return
      if (event.key === 'ArrowLeft' && previous !== undefined) onShow(previous.id)
      if (event.key === 'ArrowRight' && next !== undefined) onShow(next.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previous, next, onShow])

  const download = async () => {
    setSaving(true)
    await saveFile(file.id)
    setSaving(false)
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="flex h-[92dvh] w-[96vw] max-w-6xl flex-col gap-3 p-3 sm:max-w-6xl sm:p-4">
        <div className="flex items-center gap-2 pr-8">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm">{file.name}</DialogTitle>
            <DialogDescription className="text-xs">
              {formatBytes(file.size)}
              {at !== -1 && gallery.length > 1 && ` · ${at + 1} of ${gallery.length}`}
            </DialogDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void download()} disabled={saving}>
            <Download aria-hidden="true" />
            Download
          </Button>
        </div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-black/90" data-viewer={kind}>
          {broken ? (
            <p className="p-6 text-center text-sm text-white">This file cannot be shown here. It can still be downloaded.</p>
          ) : url === null ? (
            <p className="text-sm text-white/70">Loading…</p>
          ) : kind === 'image' ? (
            <img key={file.id} src={url} alt={file.name} onError={failed} className="max-h-full max-w-full object-contain" />
          ) : kind === 'video' ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- a file someone sent: there are no captions to offer
            <video key={file.id} src={url} controls autoPlay playsInline aria-label={file.name} onError={failed} className="max-h-full max-w-full" />
          ) : (
            <iframe key={file.id} src={url} title={file.name} className="size-full bg-white" />
          )}
          {previous !== undefined && (
            <Button variant="secondary" size="icon" className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full" onClick={() => onShow(previous.id)}>
              <ChevronLeft aria-hidden="true" />
              <span className="sr-only">Previous</span>
            </Button>
          )}
          {next !== undefined && (
            <Button variant="secondary" size="icon" className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full" onClick={() => onShow(next.id)}>
              <ChevronRight aria-hidden="true" />
              <span className="sr-only">Next</span>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
