import { CircleAlert, LoaderCircle, RotateCw, X } from 'lucide-react'
import type { DraftFile } from '@/hooks/useDraftFiles'
import { formatBytes, kindOf } from '@/lib/files'
import { cn } from '@/lib/utils'

const THUMBNAIL = 'size-10 shrink-0 rounded-md bg-muted object-cover'

interface DraftFilesProps {
  drafts: DraftFile[]
  onRemove: (key: string) => void
  /** Uploads it again — as the original, or as the smaller copy. */
  onRestart: (key: string, original: boolean) => void
}

/** The files chosen for the message being written: one chip each, with how far its upload has got. */
export function DraftFiles({ drafts, onRemove, onRestart }: DraftFilesProps) {
  return (
    <ul aria-label="Files to send" className="mx-auto flex w-full max-w-3xl flex-wrap gap-2 pb-2">
      {drafts.map(draft => {
        const working = draft.status === 'preparing' || draft.status === 'uploading'
        return (
          <li
            key={draft.key}
            data-status={draft.status}
            className={cn(
              'relative flex max-w-full items-center gap-2 overflow-hidden rounded-lg border py-1.5 pr-1.5 text-xs',
              draft.preview === undefined ? 'pl-2.5' : 'pl-1.5',
              draft.status === 'failed' && 'border-destructive/50 text-destructive',
            )}
          >
            {draft.preview !== undefined && (
              kindOf(draft.type) === 'video' ? (
                // Its first frame, as a still. (Without a time to show, some browsers show nothing.)
                <video src={`${draft.preview}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" className={THUMBNAIL} />
              ) : (
                <img src={draft.preview} alt="" className={THUMBNAIL} />
              )
            )}
            {working && <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />}
            {draft.status === 'failed' && <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />}
            <span className="flex min-w-0 flex-col">
              <span className="max-w-44 truncate font-medium">{draft.name}</span>
              <span className={cn(draft.status !== 'failed' && 'text-muted-foreground')}>
                {draft.status === 'failed'
                  ? (draft.error ?? 'Could not be uploaded')
                  : draft.status === 'preparing'
                    ? 'Getting ready…'
                    : draft.status === 'uploading'
                      ? `Uploading… ${Math.round(draft.progress * 100)}%`
                      : `${formatBytes(draft.size)}${draft.resized ? ' · made smaller' : ''}`}
              </span>
              {/* A large picture goes smaller unless asked otherwise. */}
              {(draft.resized || draft.original) && draft.status === 'ready' && (
                <label className="mt-0.5 flex cursor-pointer items-center gap-1 text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={draft.original}
                    onChange={event => onRestart(draft.key, event.target.checked)}
                    className="size-3 accent-primary"
                  />
                  Send original
                </label>
              )}
            </span>
            {draft.status === 'failed' && (
              <button
                type="button"
                onClick={() => onRestart(draft.key, draft.original)}
                aria-label={`Try ${draft.name} again`}
                className="flex size-6 shrink-0 items-center justify-center rounded-full outline-none hover:bg-foreground/10 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <RotateCw aria-hidden="true" className="size-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onRemove(draft.key)}
              aria-label={`Remove ${draft.name}`}
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-foreground outline-none hover:bg-foreground/10 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
            {draft.status === 'uploading' && (
              <span
                role="progressbar"
                aria-label={`Uploading ${draft.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(draft.progress * 100)}
                className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-primary transition-transform"
                style={{ transform: `scaleX(${draft.progress})` }}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
