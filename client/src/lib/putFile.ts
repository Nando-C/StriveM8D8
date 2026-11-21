/**
 * Sends a file's bytes to the address the server gave for it. (XMLHttpRequest, because
 * `fetch` cannot say how much of an upload has gone.) Resolves to whether storage took it.
 */
export const putFile = (
  url: string,
  headers: Record<string, string>,
  body: Blob,
  { onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<boolean> =>
  new Promise(resolve => {
    const request = new XMLHttpRequest()
    request.open('PUT', url)
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total)
    })
    request.addEventListener('load', () => resolve(request.status >= 200 && request.status < 300))
    request.addEventListener('error', () => resolve(false))
    request.addEventListener('abort', () => resolve(false))
    signal?.addEventListener('abort', () => request.abort(), { once: true })
    request.send(body)
  })
