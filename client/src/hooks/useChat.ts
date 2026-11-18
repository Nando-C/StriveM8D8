import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  UNCONFIRMED,
  chatReducer,
  initialChatState,
  otherOnlineUsers,
  selectedConversation,
  selectedUserId,
} from '@/lib/chatState'
import { deviceLabel } from '@/lib/device'
import { ask } from '@/lib/request'
import {
  clearAccount, clearSession, loadAccount, loadReservation, saveAccount, saveReservation, saveSession,
  startingSession, type Session,
} from '@/lib/session'
import { socket } from '@/lib/socket'
import { useSocketConnected } from '@/lib/useSocketConnected'
import type {
  ChatMessage,
  HistoryErrorPayload,
  HistoryPayload,
  LoggedInPayload,
  LoginErrorPayload,
  LoginPayload,
  NewLoginPayload,
  SessionRevokedPayload,
  UserLeftPayload,
} from '@/types/protocol'

/** How long to wait for the server to acknowledge a message before calling it unconfirmed. */
const ACK_TIMEOUT_MS = 10_000

/** How long to wait before logging in again after the server said it was not ready. */
export const LOGIN_RETRY_MS = 3000

/** What a guest sends to log in: the name, and the secret that reserves it if this browser holds one. */
const guestLogin = (username: string): LoginPayload => {
  const reservation = loadReservation(username)
  return reservation === undefined ? { username } : { username, reservation }
}

export const SIGNED_OUT_ELSEWHERE = 'You were signed out on this device.'

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
 * Connects the chat state (a pure reducer) to the socket.
 *
 * Rules this hook enforces:
 * - nothing but `login` is emitted while logged out. socket.io-client queues events emitted
 *   while disconnected and flushes them *before* `connect` fires, i.e. before the re-login,
 *   so anything else sent early would reach the server from a logged-out socket and fail;
 * - whenever the socket connects and a session is held, it logs in again, proving the
 *   name is its own with the reservation the server gave it;
 * - after every `loggedin`, history for the open conversation is requested again, because
 *   messages can be saved while this client was away.
 */
export const useChat = () => {
  const connected = useSocketConnected()
  // Whether a connection has ever been established. Until it has, "not connected" means
  // "still reaching the server for the first time" — on free hosting, possibly a server
  // that is waking up — which is a different thing to tell the user than "disconnected".
  const [everConnected, setEverConnected] = useState(connected)
  if (connected && !everConnected) setEverConnected(true)
  const [state, dispatch] = useReducer(chatReducer, undefined, () =>
    initialChatState(startingSession()?.username ?? null),
  )

  // The identity to log in with whenever the socket (re)connects.
  const session = useRef<Session | null>(startingSession())
  // The socket id a login was last emitted on, so one connection logs in once even when
  // React StrictMode runs the effect twice.
  const loginSentOn = useRef<string | null>(null)

  const emitLogin = useCallback((payload: LoginPayload) => {
    loginSentOn.current = socket.id ?? null
    dispatch({ type: 'loginRequested' })
    socket.emit('login', payload)
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
      session.current = null
      clearSession()
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
      // "io server disconnect" means the server closed this connection on purpose: the
      // session was taken over from another tab. socket.io does not reconnect by itself
      // in that case, and neither do we — two tabs would evict each other in a loop.
      dispatch({ type: 'disconnected', replaced: reason === 'io server disconnect' })
    }

    const onLoggedIn = (payload: LoggedInPayload) => {
      clearTimeout(retryTimer)
      session.current = { username: payload.username, sessionToken: payload.sessionToken, kind: payload.kind }
      saveSession(session.current)
      // After a password sign-in: this device's session, for every later visit and tab.
      if (payload.session !== undefined) saveAccount({ username: payload.username, session: payload.session })
      // Sent once, when the name is first reserved: without it this browser could not
      // have the name back after a reload.
      if (payload.reservation !== undefined) saveReservation(payload.username, payload.reservation)
      dispatch({ type: 'loggedIn', payload })
    }
    const onLoginError = ({ message, retryable, sessionEnded }: LoginErrorPayload) => {
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
      session.current = null
      loginSentOn.current = null
      clearSession()
      dispatch({ type: 'loginFailed', message })
    }
    const onSessionRevoked = ({ reason }: SessionRevokedPayload) => {
      revoked = true
      // Signing an account's device out applies to every tab that shares its session.
      if (session.current?.kind === 'account') clearAccount()
      session.current = null
      loginSentOn.current = null
      clearSession()
      dispatch({ type: 'loginFailed', message: reason })
    }
    const onNewLogin = (payload: NewLoginPayload) => dispatch({ type: 'userJoined', payload })
    const onUserLeft = (payload: UserLeftPayload) => dispatch({ type: 'userLeft', payload })
    const onMessage = (payload: ChatMessage) => dispatch({ type: 'messageReceived', payload, receivedAt: Date.now() })
    const onHistory = (payload: HistoryPayload) => dispatch({ type: 'historyLoaded', payload })
    const onHistoryError = (payload: HistoryErrorPayload) => dispatch({ type: 'historyFailed', payload })

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('loggedin', onLoggedIn)
    socket.on('loginError', onLoginError)
    socket.on('sessionRevoked', onSessionRevoked)
    socket.on('newLogin', onNewLogin)
    socket.on('userLeft', onUserLeft)
    socket.on('message', onMessage)
    socket.on('history', onHistory)
    socket.on('historyError', onHistoryError)

    // Leaving the page: say so. Closing a tab only drops the connection, and a host's proxy
    // can take several seconds to pass that on, during which others still see this user.
    let leftOnPageHide = false
    const onPageHide = () => {
      if (!socket.connected) return
      leftOnPageHide = true
      socket.disconnect()
    }
    // The browser can bring a page back from its back/forward cache exactly as it was left;
    // the connection closed above then has to be opened again.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || !leftOnPageHide) return
      leftOnPageHide = false
      socket.connect()
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)

    // The socket may already be connected by the time this component mounts.
    if (socket.connected) onConnect()

    // Every listener is removed again: React StrictMode runs effects twice in development,
    // and a leftover listener would handle (and render) every message twice.
    return () => {
      clearTimeout(retryTimer)
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('loggedin', onLoggedIn)
      socket.off('loginError', onLoginError)
      socket.off('sessionRevoked', onSessionRevoked)
      socket.off('newLogin', onNewLogin)
      socket.off('userLeft', onUserLeft)
      socket.off('message', onMessage)
      socket.off('history', onHistory)
      socket.off('historyError', onHistoryError)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [emitLogin])

  // (Re)load the open conversation: when one is selected, and after every (re)login.
  // A conversation selected while offline is loaded as soon as the login completes.
  useEffect(() => {
    if (state.phase === 'loggedIn' && state.selected !== null) {
      socket.emit('getHistory', { withUsername: state.selected })
    }
  }, [state.phase, state.selected, state.loginCount])

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
  }, [])

  /** Back to the entry screen as nobody. `message` says why, when it was not the user's doing. */
  const forget = useCallback((message?: string) => {
    if (session.current?.kind === 'account') clearAccount()
    session.current = null
    loginSentOn.current = null
    clearSession()
    dispatch(message === undefined ? { type: 'loggedOut' } : { type: 'loginFailed', message })
  }, [])

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

  const selectConversation = useCallback((username: string) => {
    dispatch({ type: 'conversationSelected', username })
  }, [])

  const closeConversation = useCallback(() => {
    dispatch({ type: 'conversationClosed' })
  }, [])

  const recipientId = selectedUserId(state)
  const canSend = connected && state.phase === 'loggedIn' && recipientId !== null

  const sendMessage = (text: string) => {
    const to = state.selected
    if (!canSend || to === null || recipientId === null) return

    const clientId = crypto.randomUUID()
    dispatch({ type: 'sendStarted', to, clientId, text, timestamp: Date.now() })

    // Without a timeout the callback is never called if the connection drops first,
    // and the message would stay "pending" forever.
    socket
      .timeout(ACK_TIMEOUT_MS)
      .emit('sendmessage', { toUserId: recipientId, text, clientId }, (error, response) => {
        if (error) {
          dispatch({ type: 'sendFailed', to, clientId, reason: UNCONFIRMED })
        } else if (response.ok) {
          dispatch({ type: 'sendConfirmed', to, clientId, id: response.id, timestamp: response.timestamp })
        } else {
          dispatch({ type: 'sendFailed', to, clientId, reason: response.message })
        }
      })
  }

  /** After being replaced by another tab: connect again, which logs back in. */
  const reconnect = useCallback(() => {
    socket.connect()
  }, [])

  return {
    connected,
    everConnected,
    phase: state.phase,
    username: state.username,
    kind: state.kind,
    admin: state.admin,
    loginError: state.loginError,
    users: otherOnlineUsers(state),
    selected: state.selected,
    selectedOnline: recipientId !== null,
    conversation: selectedConversation(state),
    conversations: state.conversations,
    lastIncoming: state.lastIncoming,
    canSend,
    login,
    signIn,
    signInWithSession,
    becomeAccount,
    logout,
    forget,
    selectConversation,
    closeConversation,
    sendMessage,
    reconnect,
  }
}
