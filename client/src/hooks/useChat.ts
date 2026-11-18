import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import {
  chatList, openConversation, peopleList, selectedThread, totalUnread,
} from '@/lib/chatSelectors'
import { chatReducer, initialChatState } from '@/lib/chatState'
import { directConversationId } from '@/lib/conversationId'
import { deviceLabel } from '@/lib/device'
import { UNCONFIRMED } from '@/lib/messages'
import { useIdleReporter } from '@/lib/useIdleReporter'
import { comparePositions, positionOf } from '@/lib/positions'
import { ask } from '@/lib/request'
import {
  clearAccount, clearSession, loadAccount, loadReservation, saveAccount, saveReservation, saveSession,
  startingSession, type Session,
} from '@/lib/session'
import { socket } from '@/lib/socket'
import { useSocketConnected } from '@/lib/useSocketConnected'
import type {
  ConversationUpdatedPayload,
  HistoryErrorPayload,
  HistoryPayload,
  LoggedInPayload,
  LoginErrorPayload,
  LoginPayload,
  Member,
  Message,
  OwnStatus,
  Position,
  PresencePayload,
  PublicUser,
  SetStatusPayload,
  SessionRevokedPayload,
  UserLeftPayload,
} from '@/types/protocol'

const BASE_TITLE = 'Strive Chat'

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
 *   messages can be saved while this client was away;
 * - a conversation that is on screen is reported to the server as read, so that its
 *   unread count is right on every device and at the next login.
 */
export const useChat = () => {
  const connected = useSocketConnected()
  // Whether a connection has ever been established. Until it has, "not connected" means
  // "still reaching the server for the first time" — on free hosting, possibly a server
  // that is waking up — which is a different thing to tell the user than "disconnected".
  const [everConnected, setEverConnected] = useState(connected)
  if (connected && !everConnected) setEverConnected(true)
  // The server refused this page's version of the protocol: only a reload can help.
  const [outdated, setOutdated] = useState(false)
  const [state, dispatch] = useReducer(chatReducer, undefined, () =>
    initialChatState(startingSession()?.username ?? null),
  )

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
    const onNewLogin = (payload: PublicUser) => dispatch({ type: 'userJoined', payload })
    const onUserLeft = (payload: UserLeftPayload) => dispatch({ type: 'userLeft', payload })
    const onMemberJoined = (payload: Member) => dispatch({ type: 'memberJoined', payload })
    const onPresence = (payload: PresencePayload) => dispatch({ type: 'presenceChanged', payload })
    const onOwnStatus = (ownStatus: OwnStatus) => dispatch({ type: 'ownStatusChanged', ownStatus })
    const onMemberLeft = (payload: UserLeftPayload) => dispatch({ type: 'memberLeft', payload })
    const onConversationUpdated = ({ conversation }: ConversationUpdatedPayload) =>
      dispatch({ type: 'conversationUpdated', conversation })
    const onMessage = (payload: Message) => dispatch({ type: 'messageReceived', payload, receivedAt: Date.now() })
    // Server and client are deployed separately, so for a few minutes after a release
    // this page can be older than the server. socket.io does not retry a refused
    // connection, which is right: the same page would be refused again.
    const onConnectError = (error: Error & { data?: { code?: string } }) => {
      if (error.data?.code === 'protocol') setOutdated(true)
    }
    const onHistory = (payload: HistoryPayload) => dispatch({ type: 'historyLoaded', payload })
    const onHistoryError = (payload: HistoryErrorPayload) => dispatch({ type: 'historyFailed', payload })

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('loggedin', onLoggedIn)
    socket.on('loginError', onLoginError)
    socket.on('sessionRevoked', onSessionRevoked)
    socket.on('connect_error', onConnectError)
    socket.on('newLogin', onNewLogin)
    socket.on('userLeft', onUserLeft)
    socket.on('presence', onPresence)
    socket.on('ownStatus', onOwnStatus)
    socket.on('memberJoined', onMemberJoined)
    socket.on('memberLeft', onMemberLeft)
    socket.on('conversationUpdated', onConversationUpdated)
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
    // Whether anyone is looking: a conversation open in a hidden tab is not being read.
    const onVisibilityChange = () => dispatch({ type: 'attentionChanged', attentive: document.visibilityState === 'visible' })
    document.addEventListener('visibilitychange', onVisibilityChange)
    onVisibilityChange()
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
      socket.off('connect_error', onConnectError)
      socket.off('newLogin', onNewLogin)
      socket.off('userLeft', onUserLeft)
      socket.off('presence', onPresence)
      socket.off('ownStatus', onOwnStatus)
      socket.off('memberJoined', onMemberJoined)
      socket.off('memberLeft', onMemberLeft)
      socket.off('conversationUpdated', onConversationUpdated)
      socket.off('message', onMessage)
      socket.off('history', onHistory)
      socket.off('historyError', onHistoryError)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [emitLogin])

  // (Re)load the open conversation: when one is selected, and after every (re)login.
  // A conversation selected while offline is loaded as soon as the login completes.
  useEffect(() => {
    if (state.phase === 'loggedIn' && state.selected !== null) {
      socket.emit('getHistory', { conversationId: state.selected })
    }
  }, [state.phase, state.selected, state.loginCount])

  // Tell the server how far the open conversation has been read: up to its newest
  // confirmed message, once per position.
  //
  // A layout effect on purpose: it runs in the same task that puts the messages on
  // screen, so there is no moment at which a message is visible but not yet reported.
  // Someone who glances at a message and closes the tab has still read it.
  const thread = selectedThread(state)
  const newestConfirmed = thread.messages.findLast(message => message.id !== null)
  const newestId = newestConfirmed?.id ?? null
  const newestTimestamp = newestConfirmed?.timestamp ?? 0
  const reported = useRef(new Map<string, Position>())
  useLayoutEffect(() => {
    // Only while the page is being looked at: otherwise a message that arrives in a
    // background tab would be reported as read, and lose its badge on every device.
    if (state.phase !== 'loggedIn' || !state.attentive || state.selected === null || newestId === null) return
    const position = positionOf({ id: newestId, timestamp: newestTimestamp })
    // Remembered per identity: what one user reported says nothing about the next.
    const key = `${state.userId}|${state.selected}`
    if (comparePositions(position, reported.current.get(key)) <= 0) return
    reported.current.set(key, position)
    dispatch({ type: 'readUpTo', conversationId: state.selected, position })
    void ask('markRead', { conversationId: state.selected, upTo: position })
  }, [state.phase, state.attentive, state.userId, state.selected, newestId, newestTimestamp])


  // Unread messages show in the tab's title, where they can be seen from another tab.
  const unread = totalUnread(state)
  useEffect(() => {
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${BASE_TITLE}` : BASE_TITLE
  }, [unread])

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
    awaitingLogin.current = false
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

  /** Changes what the user shows. Resolves with the server's answer, for whoever asked to show a refusal. */
  const setStatus = useCallback(async (payload: SetStatusPayload) => {
    const answer = await ask('setStatus', payload)
    if (answer.ok) {
      const { status, statusText, statusClearAt } = answer
      dispatch({ type: 'ownStatusChanged', ownStatus: { status, statusText, statusClearAt } })
    }
    return answer
  }, [])

  // Tell the server when nobody is using this page, so that others see "away".
  useIdleReporter(connected && state.phase === 'loggedIn')

  const selectConversation = useCallback((conversationId: string) => {
    dispatch({ type: 'conversationSelected', conversationId })
  }, [])

  /** Opens the direct conversation with someone, whether or not anything has been said in it. */
  const ownUserId = state.userId
  const openChatWith = useCallback(
    (person: { userId: string; username: string }) => {
      if (ownUserId === null) return
      dispatch({
        type: 'conversationSelected',
        conversationId: directConversationId(ownUserId, person.userId),
        peer: { userId: person.userId, username: person.username },
      })
    },
    [ownUserId],
  )

  const closeConversation = useCallback(() => {
    dispatch({ type: 'conversationClosed' })
  }, [])

  const open = openConversation(state)
  // The other person does not have to be online: the message waits for them.
  const canSend = connected && state.phase === 'loggedIn' && open !== null && open.counterpart?.gone !== true

  const sendMessage = (text: string) => {
    const conversationId = state.selected
    if (!canSend || conversationId === null) return

    const clientId = crypto.randomUUID()
    dispatch({ type: 'sendStarted', conversationId, clientId, text, timestamp: Date.now() })

    // Without a timeout the callback is never called if the connection drops first,
    // and the message would stay "pending" forever.
    socket
      .timeout(ACK_TIMEOUT_MS)
      .emit('sendmessage', { conversationId, text, clientId }, (error, response) => {
        if (error) {
          dispatch({ type: 'sendFailed', conversationId, clientId, reason: UNCONFIRMED })
        } else if (response.ok) {
          dispatch({ type: 'sendConfirmed', conversationId, clientId, id: response.id, timestamp: response.timestamp })
        } else {
          dispatch({ type: 'sendFailed', conversationId, clientId, reason: response.message })
        }
      })
  }

  /** Asks for the page of messages before the oldest one held for the open conversation. */
  const oldestConfirmed = thread.messages.find(message => message.id !== null)
  const loadEarlier = () => {
    const conversationId = state.selected
    if (state.phase !== 'loggedIn' || !connected || conversationId === null) return
    if (oldestConfirmed === undefined || oldestConfirmed.id === null || thread.loadingEarlier) return
    dispatch({ type: 'earlierRequested', conversationId })
    socket.emit('getHistory', {
      conversationId,
      before: positionOf({ id: oldestConfirmed.id, timestamp: oldestConfirmed.timestamp }),
    })
  }

  /** After being replaced by another tab: connect again, which logs back in. */
  const reconnect = useCallback(() => {
    socket.connect()
  }, [])

  return {
    connected,
    everConnected,
    outdated,
    phase: state.phase,
    username: state.username,
    kind: state.kind,
    admin: state.admin,
    ownStatus: state.ownStatus,
    loginError: state.loginError,
    chats: chatList(state),
    people: peopleList(state),
    /** Whether the people list covers every account, or only who is connected. */
    listsEveryone: state.directory !== null,
    selected: state.selected,
    open,
    thread,
    lastIncoming: state.lastIncoming,
    canSend,
    login,
    signIn,
    signInWithSession,
    becomeAccount,
    logout,
    forget,
    setStatus,
    selectConversation,
    openChatWith,
    closeConversation,
    sendMessage,
    loadEarlier,
    reconnect,
  }
}
