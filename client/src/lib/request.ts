import { socket } from '@/lib/socket'
import type { Ack, ClientToServerEvents } from '@/types/protocol'

/** How long to wait for the server's answer before giving up on a request. */
export const REQUEST_TIMEOUT_MS = 10_000

export const NO_ANSWER = 'No answer from the server. Check your connection and try again.'

/** The events that are answered through an acknowledgement of the common `Ack` shape. */
export type RequestEvent = Exclude<keyof ClientToServerEvents, 'login' | 'sendmessage' | 'getHistory'>

type Payload<Event extends RequestEvent> = Parameters<ClientToServerEvents[Event]>[0]
type Answer<Event extends RequestEvent> = Parameters<Parameters<ClientToServerEvents[Event]>[1]>[0]

type LooseEmit = (event: string, payload: unknown, callback: (error: Error | null, response: unknown) => void) => void

/**
 * Sends a request and resolves with the server's answer. Never rejects: a request that
 * gets no answer in time resolves as a failure worth retrying, in the same shape as a
 * refusal, so callers have one case to show.
 */
export const ask = <Event extends RequestEvent>(event: Event, payload: Payload<Event>): Promise<Answer<Event>> =>
  new Promise(resolve => {
    // Typed per event above; socket.io's own typing of `timeout().emit` does not survive a generic event name.
    const timed = socket.timeout(REQUEST_TIMEOUT_MS)
    ;(timed.emit as unknown as LooseEmit).call(timed, event, payload, (error, response) => {
      const failure: Ack = { ok: false, message: NO_ANSWER, retryable: true }
      resolve((error ? failure : response) as Answer<Event>)
    })
  })
