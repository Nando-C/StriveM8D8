import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useState } from 'react'
import { useSessionLogin } from '@/hooks/useSessionLogin'
import {
  chatList, openConversation, peopleList, selectedThread, totalUnread, unreadLabel,
} from '@/lib/chatSelectors'
import { chatReducer, initialChatState } from '@/lib/chatState'
import { directConversationId } from '@/lib/conversationId'
import { listen } from '@/lib/listen'
import { UNCONFIRMED } from '@/lib/messages'
import { useIdleReporter } from '@/lib/useIdleReporter'
import { positionOf } from '@/lib/positions'
import { createReadReporter } from '@/lib/readReporter'
import { ask } from '@/lib/request'
import { startingSession } from '@/lib/session'
import { socket } from '@/lib/socket'
import { useSocketConnected } from '@/lib/useSocketConnected'
import type {
  ConversationRemovedPayload,
  ConversationUpdatedPayload,
  HistoryErrorPayload,
  HistoryPayload,
  Member,
  Message,
  OwnStatus,
  PresencePayload,
  PublicUser,
  ReceiptPayload,
  SetStatusPayload,
  UserLeftPayload,
} from '@/types/protocol'

const BASE_TITLE = 'Strive Chat'

/** How long to wait for the server to acknowledge a message before calling it unconfirmed. */
const ACK_TIMEOUT_MS = 10_000

/** A conversation is reported as read at most this often, however fast messages arrive. */
export const READ_REPORT_INTERVAL_MS = 1000

// (Where the tests have always found them.)
export { LOGIN_RETRY_MS, SIGNED_OUT_ELSEWHERE } from '@/hooks/useSessionLogin'

/**
 * Connects the chat state (a pure reducer) to the socket.
 *
 * Rules this hook enforces:
 * - nothing but `login` is emitted while logged out. socket.io-client queues events emitted
 *   while disconnected and flushes them *before* `connect` fires, i.e. before the re-login,
 *   so anything else sent early would reach the server from a logged-out socket and fail;
 * - whenever the socket connects and a session is held, it logs in again, proving the
 *   name is its own with the reservation the server gave it (see useSessionLogin);
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

  // When "read up to here" is actually sent (see readReporter.ts). Created once.
  const [readReporter] = useState(() => createReadReporter(READ_REPORT_INTERVAL_MS))
  // Registered first: its listeners hear `loggedin` before anything below does.
  const { login, signIn, signInWithSession, becomeAccount, forget, logout } = useSessionLogin(dispatch)

  useEffect(() => {
    const onNewLogin = (payload: PublicUser) => dispatch({ type: 'userJoined', payload })
    const onUserLeft = (payload: UserLeftPayload) => dispatch({ type: 'userLeft', payload })
    const onMemberJoined = (payload: Member) => dispatch({ type: 'memberJoined', payload })
    const onMemberDirectory = ({ members }: { members: Member[] }) => dispatch({ type: 'directoryReceived', members })
    const onPresence = (payload: PresencePayload) => dispatch({ type: 'presenceChanged', payload })
    const onOwnStatus = (ownStatus: OwnStatus) => dispatch({ type: 'ownStatusChanged', ownStatus })
    const onMemberLeft = (payload: UserLeftPayload) => dispatch({ type: 'memberLeft', payload })
    const onConversationUpdated = ({ conversation }: ConversationUpdatedPayload) =>
      dispatch({ type: 'conversationUpdated', conversation })
    const onConversationRemoved = ({ id }: ConversationRemovedPayload) =>
      dispatch({ type: 'conversationRemoved', conversationId: id })
    const onMessage = (payload: Message, ack?: () => void) => {
      dispatch({ type: 'messageReceived', payload, receivedAt: Date.now() })
      // This device has it: that is what moves the sender's tick from "sent" to "delivered".
      ack?.()
    }
    const onReceipt = (payload: ReceiptPayload) => dispatch({ type: 'receipt', payload })
    // Server and client are deployed separately, so for a few minutes after a release
    // this page can be older than the server. socket.io does not retry a refused
    // connection, which is right: the same page would be refused again.
    const onConnectError = (error: Error & { data?: { code?: string } }) => {
      if (error.data?.code === 'protocol') setOutdated(true)
    }
    const onHistory = (payload: HistoryPayload) => dispatch({ type: 'historyLoaded', payload })
    const onHistoryError = (payload: HistoryErrorPayload) => dispatch({ type: 'historyFailed', payload })

    const stopListening = listen(on => {
      on('connect_error', onConnectError)
      on('newLogin', onNewLogin)
      on('userLeft', onUserLeft)
      on('presence', onPresence)
      on('ownStatus', onOwnStatus)
      on('memberJoined', onMemberJoined)
      on('memberDirectory', onMemberDirectory)
      on('memberLeft', onMemberLeft)
      on('conversationUpdated', onConversationUpdated)
      on('conversationRemoved', onConversationRemoved)
      on('message', onMessage)
      on('receipt', onReceipt)
      on('history', onHistory)
      on('historyError', onHistoryError)
    })

    // Leaving the page: say so. Closing a tab only drops the connection, and a host's proxy
    // can take several seconds to pass that on, during which others still see this user.
    let leftOnPageHide = false
    const onPageHide = () => {
      if (!socket.connected) return
      // Whatever was read in the last second and not yet reported goes out first.
      readReporter.flush()
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
    // Whether anyone is looking: a conversation open in a hidden tab, or in a window that
    // is behind another, is not being read.
    const onAttentionChange = () =>
      dispatch({ type: 'attentionChanged', attentive: document.visibilityState === 'visible' && document.hasFocus() })
    document.addEventListener('visibilitychange', onAttentionChange)
    window.addEventListener('focus', onAttentionChange)
    window.addEventListener('blur', onAttentionChange)
    onAttentionChange()
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)

    return () => {
      stopListening()
      document.removeEventListener('visibilitychange', onAttentionChange)
      window.removeEventListener('focus', onAttentionChange)
      window.removeEventListener('blur', onAttentionChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [readReporter])

  // (Re)load the open conversation: when one is selected, and after every (re)login.
  // A conversation selected while offline is loaded as soon as the login completes.
  useEffect(() => {
    if (state.phase === 'loggedIn' && state.selected !== null) {
      socket.emit('getHistory', { conversationId: state.selected })
    }
  }, [state.phase, state.selected, state.loginCount])

  // Tell the server how far the open conversation has been read: up to its newest
  // confirmed message. Only when it really is being read — the page is visible and has
  // focus, and the end of the conversation is on screen — and at most once a second per
  // conversation, however fast messages arrive.
  //
  // A layout effect on purpose: it runs in the same task that puts the messages on
  // screen, so there is no moment at which a message is visible but not yet reported.
  // Someone who glances at a message and closes the tab has still read it.
  const thread = selectedThread(state)
  const newestConfirmed = thread.messages.findLast(message => message.id !== null)
  const newestId = newestConfirmed?.id ?? null
  const newestTimestamp = newestConfirmed?.timestamp ?? 0
  // Whether the newest message is in view. True until the message list says otherwise:
  // a conversation opens at its end.
  const [atEnd, setAtEnd] = useState({ conversationId: state.selected, value: true })
  const inView = atEnd.conversationId !== state.selected || atEnd.value
  const reportAtEnd = useCallback(
    (value: boolean) => setAtEnd({ conversationId: state.selected, value }),
    [state.selected],
  )
  useLayoutEffect(() => {
    if (state.phase !== 'loggedIn' || !state.attentive || !inView || state.selected === null || newestId === null) return
    const conversationId = state.selected
    const position = positionOf({ id: newestId, timestamp: newestTimestamp })
    readReporter.offer(`${state.userId}|${conversationId}`, position, async () => {
      dispatch({ type: 'readUpTo', conversationId, position })
      return (await ask('markRead', { conversationId, upTo: position })).ok
    })
    // No longer being read (or something newer to report): what was waiting is dropped.
    return readReporter.cancel
  }, [readReporter, state.phase, state.attentive, inView, state.userId, state.selected, newestId, newestTimestamp])

  // Unread messages show in the tab's title, where they can be seen from another tab.
  const unread = totalUnread(state)
  useEffect(() => {
    document.title = unread > 0 ? `(${unreadLabel(unread)}) ${BASE_TITLE}` : BASE_TITLE
  }, [unread])

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
  // The two lists depend on a few parts of the state only: worked out again when one of
  // those changes, and otherwise the same arrays, so the sidebar is not drawn again for
  // every message that arrives in the open conversation.
  const { threads, onlineUsers, directory, userId, username } = state
  const chats = useMemo(() => chatList({ threads, onlineUsers, userId }), [threads, onlineUsers, userId])
  const people = useMemo(
    () => peopleList({ directory, onlineUsers, userId, username }),
    [directory, onlineUsers, userId, username],
  )
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
    userId: state.userId,
    username: state.username,
    kind: state.kind,
    admin: state.admin,
    ownStatus: state.ownStatus,
    loginError: state.loginError,
    chats,
    people,
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
    reportAtEnd,
    reconnect,
  }
}
