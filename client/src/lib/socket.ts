import { io, type Socket } from 'socket.io-client'
import { PROTOCOL_VERSION, type ClientToServerEvents, type ServerToClientEvents } from '@/types/protocol'

// The one connection for the whole app. It starts connecting as soon as this module is
// first imported, so always import this instance rather than calling io() again.
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  import.meta.env.VITE_BACKEND_URL,
  // The server refuses a client built for another version of the protocol (see useChat).
  { transports: ['websocket'], auth: { protocol: PROTOCOL_VERSION } },
)
