import { socket } from '@/lib/socket'

/**
 * Registers socket listeners through the `on` it hands to `register`, and returns the
 * function that removes every one of them again — so that a listener cannot be added
 * without also being taken away. (React StrictMode runs effects twice in development: a
 * leftover listener would handle, and render, every message twice.)
 */
export const listen = (register: (on: typeof socket.on) => void): (() => void) => {
  const removals: Array<() => void> = []
  const on = ((event: Parameters<typeof socket.on>[0], handler: Parameters<typeof socket.on>[1]) => {
    socket.on(event, handler)
    removals.push(() => socket.off(event, handler))
    return socket
  }) as typeof socket.on
  register(on)
  return () => removals.forEach(remove => remove())
}
