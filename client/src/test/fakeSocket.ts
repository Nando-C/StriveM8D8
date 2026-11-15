import { vi } from 'vitest'

// A stand-in for the socket.io client, used in place of src/lib/socket.ts in every test.
// Tests play the server: they inspect what the app emitted and trigger events back.

type Handler = (...args: unknown[]) => void

export interface Emitted {
  event: string
  payload: unknown
  /** Present for events sent with an acknowledgement; call it to answer as the server. */
  ack?: (response: unknown) => void
}

class FakeSocket {
  connected = false
  id: string | undefined = undefined
  /** Everything the app has emitted, in order. */
  emitted: Emitted[] = []

  private handlers = new Map<string, Set<Handler>>()

  on = vi.fn((event: string, handler: Handler) => {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler)
    return this
  })

  off = vi.fn((event: string, handler: Handler) => {
    this.handlers.get(event)?.delete(handler)
    return this
  })

  emit = vi.fn((event: string, payload?: unknown) => {
    this.emitted.push({ event, payload })
    return this
  })

  /** Mirrors socket.timeout(ms).emit(event, payload, (error, response) => …). */
  timeout = vi.fn((ms: number) => ({
    emit: (event: string, payload: unknown, callback: (error: Error | null, response?: unknown) => void) => {
      const timer = setTimeout(() => callback(new Error('operation has timed out')), ms)
      this.emitted.push({
        event,
        payload,
        ack: response => {
          clearTimeout(timer)
          callback(null, response)
        },
      })
    },
  }))

  connect = vi.fn()

  // ---------- test controls

  /** Deliver a server event to the app. */
  trigger(event: string, ...args: unknown[]) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args)
  }

  simulateConnect(id: string) {
    this.connected = true
    this.id = id
    this.trigger('connect')
  }

  simulateDisconnect(reason = 'transport close') {
    this.connected = false
    this.id = undefined
    this.trigger('disconnect', reason)
  }

  /** Payloads of every emit of `event`, in order. */
  sent<T = unknown>(event: string): T[] {
    return this.emitted.filter(entry => entry.event === event).map(entry => entry.payload as T)
  }

  /** The most recent emit of `event`, including its acknowledgement callback. */
  last(event: string): Emitted {
    const entry = this.emitted.filter(candidate => candidate.event === event).at(-1)
    if (entry === undefined) throw new Error(`nothing was emitted for "${event}"`)
    return entry
  }

  listenerCount() {
    let count = 0
    for (const handlers of this.handlers.values()) count += handlers.size
    return count
  }

  reset() {
    this.connected = false
    this.id = undefined
    this.emitted = []
    this.handlers.clear()
    this.on.mockClear()
    this.off.mockClear()
    this.emit.mockClear()
    this.timeout.mockClear()
    this.connect.mockClear()
  }
}

export const fakeSocket = new FakeSocket()
