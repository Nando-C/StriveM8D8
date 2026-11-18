// Invitations travel as a link to this page: `…/?invite=<code>`.

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

/** Once used, the code should not sit in the address bar (or be bookmarked with it). */
export const dropInvitationFromLink = () => {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('invite')) return
  url.searchParams.delete('invite')
  window.history.replaceState(null, '', url)
}
