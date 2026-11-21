import { ask } from '@/lib/request'

// Files uploaded for a message that then did not go. Left alone they would wait on the
// server for a quarter of an hour, in the way of attaching anything else: their places
// are given back — now if the user is logged in, and otherwise as soon as they are again
// (a send most often fails because the connection dropped).

/** How long before asking again for one that could not be given back just then. */
export const GIVE_BACK_RETRY_MS = 20_000

// The server's answer for a file that is not waiting (any more): it went with the
// message after all, or was given back already. Either way there is nothing left to do.
const NOTHING_TO_GIVE_BACK = 'Unknown file'

const waiting = new Set<string>()
/** Asked, and not answered yet: never asked twice at once. */
const asking = new Set<string>()
/** Whose files they are, and whether that user is logged in right now. */
let owner: string | null = null
let able = false
let retry: ReturnType<typeof setTimeout> | undefined

const flush = () => {
  clearTimeout(retry)
  retry = undefined
  // (Logged out, nothing is sent but a login.)
  if (!able) return
  for (const fileId of waiting) {
    if (asking.has(fileId)) continue
    asking.add(fileId)
    void ask('cancelUpload', { fileId }).then(answer => {
      asking.delete(fileId)
      if (answer.ok || answer.message === NOTHING_TO_GIVE_BACK) waiting.delete(fileId)
      // Anything else — no answer, too many requests — is asked again in a while.
      else if (waiting.has(fileId)) retry ??= setTimeout(flush, GIVE_BACK_RETRY_MS)
    })
  }
}

/** Gives back the places of `fileIds`: at once if that can be done, and otherwise when it can. */
export const giveBackUploads = (fileIds: string[]) => {
  for (const fileId of fileIds) waiting.add(fileId)
  flush()
}

/**
 * Who is using the page (`null`: nobody yet), and whether they are logged in and connected.
 * What one user left to give back is not asked for in another's name.
 */
export const uploadsCanBeGivenBack = (userId: string | null, loggedIn: boolean) => {
  if (userId !== owner) {
    if (owner !== null) forgetUploadsToGiveBack()
    owner = userId
  }
  able = loggedIn
  flush()
}

/** For tests, and when the page changes hands. */
export const forgetUploadsToGiveBack = () => {
  clearTimeout(retry)
  retry = undefined
  waiting.clear()
  asking.clear()
}
