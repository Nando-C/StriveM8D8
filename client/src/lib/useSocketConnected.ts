import { useSyncExternalStore } from 'react'
import { socket } from '@/lib/socket'

const subscribe = (onChange: () => void) => {
  socket.on('connect', onChange)
  socket.on('disconnect', onChange)
  return () => {
    socket.off('connect', onChange)
    socket.off('disconnect', onChange)
  }
}

const getSnapshot = () => socket.connected

/**
 * Whether the socket is connected right now.
 *
 * Reads the socket's current state rather than only listening for future events: the
 * connection starts when the socket module is first imported, so a component that mounts
 * later may already have missed the `connect` event.
 */
export const useSocketConnected = () => useSyncExternalStore(subscribe, getSnapshot)
