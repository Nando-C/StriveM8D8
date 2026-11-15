# Strive Chat — real-time 1:1 chat

A full-stack chat app where every message goes to exactly one recipient, conversations are stored in MongoDB, and history survives reconnects. The server is Node.js, Express, Socket.IO and Mongoose; the client is React and TypeScript, in the same repository.

**Server**

- **True 1:1 delivery** — a message is sent into the recipient's own socket room and nowhere else.
- **Persistent history** — conversations are keyed by the pair of usernames, so they are still there after either side reconnects with a new socket id.
- **Live presence** — clients learn who is online, who arrived and who left over the socket itself, with no polling.
- **Reconnect-safe identity** — a session token lets a client reclaim its own username after a dropped connection.
- **Defensive by default** — every payload is validated, every send is acknowledged, and the server stays up and keeps serving presence when the database is unreachable.

**Client**

- **Pick a name, pick a person, chat** — a list of who is online, one conversation per person, history loaded when you open it, unread counts for the rest.
- **Honest message states** — your own messages show as sending, sent, or not sent with the reason; a message whose confirmation was lost in a disconnect is recovered from history, never duplicated.
- **Survives real networks** — reconnects and logs back in by itself after a dropped connection, a server restart or a page reload, and catches up on messages it missed.
- **Works everywhere it should** — side-by-side layout on desktop, separate list and conversation views on a phone, light and dark themes following the system, fully usable from the keyboard and announced to screen readers, with motion that steps aside when the system asks for reduced motion.

## Origin

This started as a Strive School exercise (module 8, day 8). The brief was:

> Implement a 1 to 1 chat, considering that socket.io is conveniently having each socket join automatically a room which has the same name of that socket id. […] On click on any of the available users, set the "current chat user" with the selected socket id and retrieve the previous messages with that socket id.

The original submission, and the lecture's starter front-end ([`apr21-chat-fe`](https://github.com/luisanton-io/apr21-chat-fe)), implemented something simpler: two shared rooms that every member broadcast into, with no stored messages. This repository has since been redesigned to do what the brief actually asked for, with a new front-end built for it in `client/`. That was a deliberate breaking change — the old starter front-end is no longer wire-compatible with this server.

One deliberate deviation from a literal reading of the brief: history is keyed by **username pair**, not by socket id. Socket ids are issued per connection and change on every reconnect, so "the previous messages with that socket id" could never be found again after a page reload.

## Repository layout

Two independent packages in one repository: the server at the root, the client in `client/`. Each has its own `package.json` and lockfile; they share nothing but the protocol.

```
src/                        SERVER
├── index.js                Bootstrap only: create the app, connect to MongoDB, listen
├── app.js                  createApp() — builds Express + HTTP server + Socket.IO, no side effects
├── db.js                   connectDB() with retry, isDatabaseReady()
├── routes.js               REST routes (GET /online-users)
├── sockets/index.js        All socket events; owns the online-users state for its app instance
└── models/message.js       Message model and the conversation key helper
test/                       Server integration tests (real socket clients, in-memory MongoDB)

client/                     CLIENT
└── src/
    ├── App.tsx             Login screen or chat shell
    ├── components/         LoginForm, Sidebar, MessageList, MessageComposer, ConnectionBanner, …
    │   └── ui/             shadcn/ui components (source files, see below)
    ├── hooks/useChat.ts    The only code that touches the socket
    ├── lib/chatState.ts    Every state change, as a pure reducer
    ├── lib/                socket, session storage, motion timings, formatting
    ├── types/protocol.ts   The wire protocol as TypeScript types
    └── test/               Client tests (the real app against a fake socket)
```

On the server, `createApp()` neither listens nor connects to the database, and the online-users state is created per app instance rather than at module level. That is what lets the tests start a fresh, isolated server for every test case.

## Socket protocol

Connect with any Socket.IO v4 client. Browser clients must come from an origin listed in `FRONTEND_URL`.

### Client → server

| Event | Payload | Reply |
|-------|---------|-------|
| `login` | `{ username, sessionToken? }` | `loggedin` or `loginError` |
| `sendmessage` | `{ toUserId, text, clientId }` + acknowledgement callback | The acknowledgement (below) |
| `getHistory` | `{ withUsername }` | `history` or `historyError` |

- `username`: 1–30 characters from `A–Z a–z 0–9 _ -`. Must not already be online (unless reclaimed with a `sessionToken`, see [Design notes](#design-notes)).
- `toUserId`: the recipient's current socket id, as given in the online-users list.
- `text`: 1–2000 characters.
- `clientId`: an id the client generates for each message (for example a UUID); 1–64 characters from `A–Z a–z 0–9 -`.

`sendmessage` is always answered through its acknowledgement callback:

```js
{ ok: true, id, timestamp }     // saved, and delivered if the recipient is still online; id is the stored message's id
{ ok: false, message }          // nothing was saved or delivered
```

Failure messages: `Invalid message`, `Not logged in`, `Cannot message yourself`, `Recipient is not online`, `Message could not be saved`.

### Server → client

| Event | Sent to | Payload | Meaning |
|-------|---------|---------|---------|
| `loggedin` | The socket that logged in | `{ username, id, sessionToken, onlineUsers }` | Login accepted. `onlineUsers` is the current list (`{ username, id }[]`, including you). `sessionToken` is private to this client. |
| `loginError` | The socket that tried | `{ message }` | `Invalid username`, `Username already in use`, or `Already logged in`. |
| `newLogin` | Everyone else | `{ username, id }` | A user came online, or an online user now has a new socket id. Treat as an upsert by username. |
| `userLeft` | Everyone else | `{ id }` | The user with that socket id went offline. |
| `message` | The recipient only | `{ id, from, fromId, text, timestamp }` | A message for you. `from` is the sender's username, `fromId` their socket id. |
| `history` | The requester only | `{ withUsername, messages }` | The most recent 100 messages of that conversation, oldest first. Each is `{ id, clientId, from, to, text, timestamp }`. |
| `historyError` | The requester only | `{ withUsername, message }` | `Invalid username`, `Not logged in`, or `History could not be loaded`. |

`timestamp` is milliseconds since the Unix epoch. The same message has the same `id` and `timestamp` in the live `message` event, in the sender's acknowledgement, and in `history`. `clientId` is `null` in history for messages that were not sent by a client.

`disconnect` is Socket.IO's built-in event; there is no logout event. Closing the connection takes the user offline.

### REST

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/online-users` | `{ onlineUsers: [{ username, id }] }` |

Clients do not need this endpoint — presence arrives over the socket, and the client in this repository never calls it — but it is handy for inspection. Unknown routes return `404` with a JSON body.

### Design notes

Three choices a reader might otherwise wonder about:

- **Presence travels only over the socket.** A client gets a snapshot of who is online inside `loggedin`, then `newLogin` and `userLeft` as changes happen. Because all three arrive in order on one connection, the list can never be overwritten by a slower HTTP response that is already out of date.
- **The session token exists for reconnects.** When a connection drops without a clean close (a laptop sleeping, a network change), the browser reconnects within seconds, but the server still lists the old socket until its heartbeat times out. Without help, the user's own automatic re-login would be refused as "username already in use". Each login therefore returns a random token; presenting it on the next login lets the same client take over its own stale entry, and the old socket is disconnected.
- **Every message has two ids.** The server id lets a client merge live messages with loaded history without showing anything twice. The client-generated `clientId` covers the case where a message was saved but its acknowledgement was lost in a disconnect: the sender never learned the server id, but can still recognise its own message when it comes back in history.

### Known limitations

- **No authentication.** Usernames are unique among users who are online, but there are no passwords: anyone can log in under a name that is currently offline and read that name's history. Treat it as a demo, not a place for private conversations.
- **Online recipients only.** A message can only be sent to a user who is connected; there is no offline delivery queue.
- **History is capped** at the most recent 100 messages per conversation.
- **Single instance.** The online-users list lives in the server's memory, so the server cannot be scaled to several instances as it stands.

## Client

The client in `client/` is a single-page app that speaks the [socket protocol](#socket-protocol) above; that section is the reference for every event and payload, and `client/src/types/protocol.ts` mirrors it as types. The types are a hand-kept copy on purpose — the server is plain JavaScript and the two packages are independent, so there is no shared-types package.

### How it is put together

- **State is a pure reducer** (`lib/chatState.ts`). Presence, conversations, unread counts and message states all change in one place that has no socket, storage or timers in it.
- **One hook owns the socket** (`hooks/useChat.ts`). It translates socket events into reducer actions and enforces the rules that make reconnection safe: nothing but `login` is sent while logged out, every connection logs in with the session token, and the open conversation's history is requested again after every login.
- **Messages are merged, never appended blindly.** Live messages and loaded history are combined by server id, and the user's own unconfirmed messages are matched by `clientId`, so nothing is shown twice and nothing unsent is lost.
- **The session lives in `sessionStorage`** — per tab, gone when the tab closes. A reload keeps you logged in; a duplicated tab takes the session over and the original says so instead of fighting for it.

### Stack

| | |
|---|---|
| Build | Vite, TypeScript |
| UI | React 19, Tailwind CSS 4, shadcn/ui (Radix primitives), lucide icons |
| Motion | Motion, with timings defined once in `lib/motion.ts` |
| Realtime | socket.io-client |
| Quality | Vitest + Testing Library, oxlint |

shadcn/ui is not a component library you install: its CLI copies each component's source into `client/src/components/ui/`, where it is ordinary code in this repository. Only the pieces underneath (Radix primitives, a class-merging helper, a stylesheet) are dependencies.

## Getting started

Requirements: Node.js 22 or newer, [pnpm](https://pnpm.io) (the version is pinned in each `package.json`; `corepack enable pnpm` sets it up), and a MongoDB database — a local `mongod` or a hosted cluster.

```bash
# 1. Server (repository root)
pnpm install
cp .env.example .env                  # then fill in the values below

# 2. Client
cd client
pnpm install
cp .env.example .env                  # then set VITE_BACKEND_URL
cd ..

# 3. Run both
pnpm dev:all
```

Then open the address Vite prints (by default `http://localhost:5173`). To try a conversation on your own, open it in a second tab and join with a different name.

`pnpm dev:all` runs the two dev servers side by side with labelled output. They can also be started separately: `pnpm dev` in the root for the server, `pnpm dev` in `client/` for the client.

### Environment variables

Server — `.env` in the repository root:

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Port to listen on. Defaults to `3001`. |
| `FRONTEND_URL` | For browser clients | Comma-separated list of origins allowed to connect. It must include the client's origin, e.g. `http://localhost:5173` (a trailing slash is fine). Requests with no `Origin` header (non-browser clients) are always allowed. If unset, no browser origin is allowed. |
| `MONGO_CONNECTION` | For messaging | MongoDB connection string, including the database name. If unset or unreachable the server still runs and serves presence; sending and history fail with a clear error, and the connection is retried until it succeeds. A malformed connection string is reported once and not retried. |

Client — `client/.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_BACKEND_URL` | Yes | Address of the server, e.g. `http://localhost:3001`. It is built into the client at build time, so changing it means restarting the dev server or rebuilding. |

If the client stays on "Connecting…", the usual cause is that its origin is missing from the server's `FRONTEND_URL`.

### Scripts

Server (repository root):

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Start the server with automatic reload on file changes |
| `pnpm start` | Start the server with plain `node` |
| `pnpm dev:all` | Start the server and the client dev server together |
| `pnpm test` | Run the server test suite |
| `pnpm lint` | Lint `src/` and `test/` with oxlint |

Client (`client/`):

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Start the Vite dev server |
| `pnpm build` | Type-check and build for production into `client/dist` |
| `pnpm preview` | Serve the production build locally |
| `pnpm test` | Run the client test suite |
| `pnpm lint` | Lint with oxlint |

## Testing

```bash
pnpm test               # server
cd client && pnpm test  # client
```

**Server.** The suite is integration-level: each test boots a fresh server on a free port, connects real Socket.IO clients to it, and talks to an in-memory MongoDB, so nothing needs to be running and no external database is touched. The first run downloads a MongoDB binary and takes longer; after that a full run takes a few seconds. It covers login and username rules, session-token takeover, presence broadcasts, targeted delivery (including that third parties receive nothing), every send-failure path, malformed payloads, the origin allowlist, history after a reconnect, the 100-message cap and ordering, and behaviour when the database is down, has never connected, or comes back.

**Client.** The tests render the real app against a fake socket, so each test plays the server: it checks what the app sent and sends events back. They cover logging in and being refused, the people list through arrivals, reconnects and departures, history and exactly-once merging, unread counts, sending and both kinds of acknowledgement, lost acknowledgements, re-login with the session token, the stored session, being signed in from another tab, and the reduced-motion setting. Elements are found by role and label, the way assistive technology finds them.

## Tech stack

**Server:** Node.js · Express 4 · Socket.IO 4 · Mongoose 9 / MongoDB · Vitest · oxlint

**Client:** React 19 · TypeScript · Vite · Tailwind CSS 4 · shadcn/ui · Motion · socket.io-client · Vitest + Testing Library · oxlint

**Both:** pnpm
