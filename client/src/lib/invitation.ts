// Invitations travel as a link to this page: `…/?invite=<code>`.
//
// The owner of a deployment registers its first administrator the same way, with the
// bootstrap code they set on the server: `…/?bootstrap=<code>`.

/** The link to send: this page, with the code for the sign-up form to pick up. */
export const invitationLink = (code: string) => {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('invite', code)
  return url.toString()
}

/** The code in the link the reader followed, or '' if they did not come by one. */
export const invitationFromLink = () => new URLSearchParams(window.location.search).get('invite') ?? ''

/** The owner's bootstrap code in the link, or '' — which is the case for everyone else. */
export const bootstrapFromLink = () => new URLSearchParams(window.location.search).get('bootstrap') ?? ''

/** Once used, a code should not sit in the address bar (or be bookmarked with it). */
export const dropCodesFromLink = () => {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('invite') && !url.searchParams.has('bootstrap')) return
  url.searchParams.delete('invite')
  url.searchParams.delete('bootstrap')
  window.history.replaceState(null, '', url)
}
