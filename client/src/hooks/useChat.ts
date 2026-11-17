import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  UNCONFIRMED,
  chatReducer,
  initialChatState,
  otherOnlineUsers,
  selectedConversation,
  selectedUserId,
} from '@/lib/chatState'
import { clearSession, loadSession, saveSession, type Session } from '@/lib/session'
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
  UserLeftPayload,
} from '@/types/protocol'

/** How long to wait for the server to acknowledge a message before calling it unconfirmed. */
const ACK_TIMEOUT_MS = 10_000

/**
 * Connects the chat state (a pure reducer) to the socket.
 *
 * Rules this hook enforces:
 * - nothing but `login` is emitted while logged out. socket.io-client queues events emitted
 *   while disconnected and flushes them *before* `connect` fires, i.e. before the re-login,
 *   so anything else sent early would reach the server from a logged-out socket and fail;
 * - whenever the socket connects and a session is held, it logs in again with the token;
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
    initialChatState(loadSession()?.username ?? null),
  )

  // The identity to log in with whenever the socket (re)connects.
  const session = useRef<Session | null>(loadSession())
  // The socket id a login was last emitted on, so one connection logs in once even when
  // React StrictMode runs the effect twice.
  const loginSentOn = useRef<string | null>(null)

  const emitLogin = useCallback((payload: LoginPayload) => {
    loginSentOn.current = socket.id ?? null
    dispatch({ type: 'loginRequested' })
    socket.emit('login', payload)
  }, [])

  useEffect(() => {
    const onConnect = () => {
      if (session.current !== null && loginSentOn.current !== socket.id) {
        emitLogin(session.current)
      }
    }
    const onDisconnect = (reason: string) => {
      loginSentOn.current = null
      // "io server disconnect" means the server closed this connection on purpose: the
      // session was taken over from another tab. socket.io does not reconnect by itself
      // in that case, and neither do we — two tabs would evict each other in a loop.
      dispatch({ type: 'disconnected', replaced: reason === 'io server disconnect' })
    }

    const onLoggedIn = (payload: LoggedInPayload) => {
      session.current = { username: payload.username, sessionToken: payload.sessionToken }
      saveSession(session.current)
      dispatch({ type: 'loggedIn', payload })
    }
    const onLoginError = ({ message }: LoginErrorPayload) => {
      session.current = null
      loginSentOn.current = null
      clearSession()
      dispatch({ type: 'loginFailed', message })
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
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('loggedin', onLoggedIn)
      socket.off('loginError', onLoginError)
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
      emitLogin({ username })
    },
    [emitLogin],
  )

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
    loginError: state.loginError,
    users: otherOnlineUsers(state),
    selected: state.selected,
    selectedOnline: recipientId !== null,
    conversation: selectedConversation(state),
    conversations: state.conversations,
    lastIncoming: state.lastIncoming,
    canSend,
    login,
    selectConversation,
    closeConversation,
    sendMessage,
    reconnect,
  }
}
