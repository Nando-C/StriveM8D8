import { createLocalStorage } from './local.js'
import { createS3Storage } from './s3.js'

// Where uploaded files live. One interface, two drivers:
//
//   presignUpload({ key, type, size, baseUrl })            → { url, headers }
//   presignDownload({ key, name, type, inline, baseUrl })  → url
//   copy(from, to)                             → whether there was anything at `from`
//   head(key)                                              → { size } or null
//   remove(key)
//
// The browser sends and fetches the bytes itself, with a short-lived URL that allows
// exactly one thing; the server only ever signs. `baseUrl` is this server's own address
// as the client reached it — used by the local driver, whose URLs point back here.
//
// `s3` is any S3-compatible service (the bucket must be private); `local` is a folder,
// for development and tests. Neither configured: no storage, and the feature is off.

/** How long an upload URL is good for — and so how long a reserved upload may stay unused. */
export const UPLOAD_URL_SECONDS = 15 * 60
export const DOWNLOAD_URL_SECONDS = 5 * 60

// Shown in the page only if it cannot do anything there: no scripts, no markup.
// Everything else — SVG and HTML above all — is only ever offered as a download.
const INLINE_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac',
    'application/pdf',
])
export const isInlineType = type => INLINE_TYPES.has(type)

/** A file name as it may go into a Content-Disposition header: both forms, nothing that could end the header. */
export const contentDisposition = (name, inline) => {
    const plain = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    return `${inline ? 'inline' : 'attachment'}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

/** The storage a deployment is configured for, or null. */
export const createStorage = settings => {
    if (settings.fileStorage === 'local') return createLocalStorage({ directory: settings.localStorageDir })
    if (settings.fileStorage === 's3') return createS3Storage(settings.s3)
    return null
}
