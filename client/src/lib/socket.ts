import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from '@/types/protocol'

// The one connection for the whole app. It starts connecting as soon as this module is
// first imported, so always import this instance rather than calling io() again.
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  import.meta.env.VITE_BACKEND_URL,
  { transports: ['websocket'] },
)
