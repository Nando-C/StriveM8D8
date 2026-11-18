import { useCallback, useEffect, useRef, type Dispatch } from 'react'
import type { ChatAction } from '@/lib/chatState'
import { deviceLabel } from '@/lib/device'
import { listen } from '@/lib/listen'
import { ask } from '@/lib/request'
import {
  clearAccount, clearSession, loadAccount, loadReservation, saveAccount, saveReservation, saveSession,
  startingSession, type Session,
} from '@/lib/session'
import { socket } from '@/lib/socket'
import type { LoggedInPayload, LoginErrorPayload, LoginPayload, SessionRevokedPayload } from '@/types/protocol'

/** How long to wait before logging in again after the server said it was not ready. */
export const LOGIN_RETRY_MS = 3000

export const SIGNED_OUT_ELSEWHERE = 'You were signed out on this device.'

/** What a guest sends to log in: the name, and the secret that reserves it if this browser holds one. */
const guestLogin = (username: string): LoginPayload => {
  const reservation = loadReservation(username)
  return reservation === undefined ? { username } : { username, reservation }
}

/**
 * What to send to log back in as `session`, or `null` if that is no longer possible: an
 * account whose device session another tab has signed out.
 */
const reLogin = (session: Session): LoginPayload | null => {
  if (session.kind === 'guest') return guestLogin(session.username)
  const account = loadAccount()
  if (account === null || account.username !== session.username) return null
  // The token from this tab's previous connection lets the server replace that
  // connection rather than count this one as a further device.
  return session.sessionToken === '' ? { session: account.session } : { session: account.session, sessionToken: session.sessionToken }
}

/**
 * Who this tab is, and keeping it logged in as them: the session it holds, logging in
 * again whenever the socket (re)connects, and every way of getting or giving up a
 * session. What the screen shows of it is in the chat state, told through `dispatch`.
 */
export const useSessionLogin = (dispatch: Dispatch<ChatAction>) => {
  // The identity to log in with whenever the socket (re)connects.
  const session = useRef<Session | null>(startingSession())
  // The socket id a login was last emitted on, so one connection logs in once even when
  // React StrictMode runs the effect twice.
  const loginSentOn = useRef<string | null>(null)
  // Whether an answer to a login is still wanted. Signing out while one is on its way
  // withdraws it: the answer, when it comes, must not sign the user back in.
  const awaitingLogin = useRef(false)

  const emitLogin = useCallback((payload: LoginPayload) => {
    awaitingLogin.current = true
    loginSentOn.current = socket.id ?? null
    dispatch({ type: 'loginRequested' })
    socket.emit('login', payload)
  }, [dispatch])

  /** This tab is nobody now. (What the screen is told, and what else is forgotten, is the caller's.) */
  const dropSession = useCallback(() => {
    session.current = null
    loginSentOn.current = null
    clearSession()
  }, [])

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    // The server signed this connection out on purpose and is about to close it.
    let revoked = false

    // Logs in as the held session, or gives it up if it can no longer be used.
    const logBackIn = () => {
      if (session.current === null) return
      const payload = reLogin(session.current)
      if (payload !== null) {
        emitLogin(payload)
        return
      }
      dropSession()
      dispatch({ type: 'loginFailed', message: SIGNED_OUT_ELSEWHERE })
    }
    const onConnect = () => {
      if (session.current !== null && loginSentOn.current !== socket.id) logBackIn()
    }
    const onDisconnect = (reason: string) => {
      loginSentOn.current = null
      clearTimeout(retryTimer)
      if (revoked) {
        // Already back on the entry form (see onSessionRevoked). socket.io does not
        // reconnect after the server closes a connection, and the form needs one.
        revoked = false
        socket.connect()
        return
      }
      // A first login that was on its way has no answer coming any more, and nothing here
      // would send it again (a password is not kept to resend): back to the form.
      if (session.current === null) awaitingLogin.current = false
      // "io server disconnect" means the server closed this connection on purpose: the
      // session was taken over from another tab. socket.io does not reconnect by itself
      // in that case, and neither do we — two tabs would evict each other in a loop.
      dispatch({ type: 'disconnected', replaced: reason === 'io server disconnect' })
    }

    const onLoggedIn = (payload: LoggedInPayload, confirm?: () => void) => {
      clearTimeout(retryTimer)
      if (!awaitingLogin.current) {
        // The user signed out while this login was under way. The server now has this
        // connection logged in (and, after a password, a new device session): undo that.
        void ask('logout', {})
        return
      }
      awaitingLogin.current = false
      session.current = { username: payload.username, sessionToken: payload.sessionToken, kind: payload.kind }
      saveSession(session.current)
      // After a password sign-in: this device's session, for every later visit and tab.
      if (payload.session !== undefined) saveAccount({ username: payload.username, session: payload.session })
      // Sent once, when the name is first reserved: without it this browser could not
      // have the name back after a reload.
      if (payload.reservation !== undefined) saveReservation(payload.username, payload.reservation)
      // Tell the server it arrived. For a name just reserved the server is waiting for
      // this: until it hears, it assumes the secret was lost on the way and frees the name.
      confirm?.()
      dispatch({ type: 'loggedIn', payload })
    }
    const onLoginError = ({ message, retryable, sessionEnded }: LoginErrorPayload) => {
      // An answer to a login that was withdrawn by signing out: nothing to show for it.
      if (!awaitingLogin.current) return
      // The device session is gone for good; asking with it again would only fail again.
      if (sessionEnded === true) clearAccount()
      // Logging back in by itself, and the server only said "not yet" (it is still
      // starting): keep the session and ask again shortly, instead of dropping the user
      // back to the form as if their name had been refused.
      if (retryable === true && session.current !== null) {
        const sentOn = socket.id
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          if (socket.connected && socket.id === sentOn) logBackIn()
        }, LOGIN_RETRY_MS)
        return
      }
      awaitingLogin.current = false
      dropSession()
      dispatch({ type: 'loginFailed', message })
    }
    const onSessionRevoked = ({ reason }: SessionRevokedPayload) => {
      revoked = true
      // Signing an account's device out applies to every tab that shares its session.
      if (session.current?.kind === 'account') clearAccount()
      dropSession()
      dispatch({ type: 'loginFailed', message: reason })
    }

    const stopListening = listen(on => {
      on('connect', onConnect)
      on('disconnect', onDisconnect)
      on('loggedin', onLoggedIn)
      on('loginError', onLoginError)
      on('sessionRevoked', onSessionRevoked)
    })
    // The socket may already be connected by the time this component mounts.
    if (socket.connected) onConnect()

    return () => {
      clearTimeout(retryTimer)
      stopListening()
    }
  }, [dispatch, emitLogin, dropSession])

  // Allowed before the socket has connected: `login` is the one event that may be queued,
  // and socket.io sends it as soon as the connection is up. Someone who types a name and
  // presses Enter straight away is not made to do it twice.
  const login = useCallback(
    (username: string) => {
      emitLogin(guestLogin(username))
    },
    [emitLogin],
  )

  const signIn = useCallback(
    (username: string, password: string) => {
      emitLogin({ username, password, deviceLabel: deviceLabel() })
    },
    [emitLogin],
  )

  /** Logs in to the account just created (or recovered) on this device. */
  const signInWithSession = useCallback(
    (username: string, deviceSession: string) => {
      saveAccount({ username, session: deviceSession })
      emitLogin({ session: deviceSession })
    },
    [emitLogin],
  )

  /** The guest who is logged in has registered their name: carry on as that account. */
  const becomeAccount = useCallback((deviceSession: string, admin: boolean) => {
    if (session.current === null) return
    saveAccount({ username: session.current.username, session: deviceSession })
    session.current = { ...session.current, kind: 'account' }
    saveSession(session.current)
    dispatch({ type: 'becameAccount', admin })
  }, [dispatch])

  /** Back to the entry screen as nobody. `message` says why, when it was not the user's doing. */
  const forget = useCallback((message?: string) => {
    if (session.current?.kind === 'account') clearAccount()
    awaitingLogin.current = false
    dropSession()
    dispatch(message === undefined ? { type: 'loggedOut' } : { type: 'loginFailed', message })
  }, [dispatch, dropSession])

  /**
   * Signs this device out. The server keeps the connection open, logged out, so the entry
   * screen works at once. A guest's name stays reserved to this browser.
   */
  const logout = useCallback(() => {
    // Sent while still logged in; the answer is not waited for. Offline, the device is
    // signed out here regardless, and its session ends on the server when it expires.
    if (socket.connected) void ask('logout', {})
    forget()
  }, [forget])

  return { login, signIn, signInWithSession, becomeAccount, forget, logout }
}
