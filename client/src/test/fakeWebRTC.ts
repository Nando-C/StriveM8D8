// Stand-ins for the parts of a browser that make calls, which the test environment does
// not have: a connection that records what it is told and lets a test play the other
// end, and streams that are only lists of tracks.

export interface FakeTrack {
  kind: 'audio' | 'video'
  enabled: boolean
  readyState: 'live' | 'ended'
  stop: () => void
  onended: (() => void) | null
  getSettings: () => { deviceId?: string; facingMode?: string }
}

export const track = (kind: 'audio' | 'video', settings: { deviceId?: string; facingMode?: string } = {}): FakeTrack => {
  const made: FakeTrack = {
    kind, enabled: true, readyState: 'live', onended: null, getSettings: () => settings,
    stop: () => { made.readyState = 'ended' },
  }
  return made
}

/** What a fake connection sends one kind of thing through. */
export interface FakeSender {
  track: FakeTrack | null
  replaceTrack: (next: FakeTrack | null) => Promise<void>
}

/** The line the two ends talk to each other on, as one end holds it. */
export class FakeChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting'
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  label: string
  options: unknown
  constructor(label: string, options: unknown) {
    this.label = label
    this.options = options
  }
  send = (data: string) => {
    if (this.readyState !== 'open') throw new Error('not open')
    this.sent.push(data)
  }
  // ---------- test controls
  open = () => {
    this.readyState = 'open'
    this.onopen?.()
  }
  /** The other end says something. */
  receive = (data: unknown) => this.onmessage?.({ data })
}

export class FakeMediaStream {
  private tracks: FakeTrack[]
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks]
  }
  getTracks = () => [...this.tracks]
  getAudioTracks = () => this.tracks.filter(candidate => candidate.kind === 'audio')
  getVideoTracks = () => this.tracks.filter(candidate => candidate.kind === 'video')
  addTrack = (added: FakeTrack) => {
    if (!this.tracks.includes(added)) this.tracks.push(added)
  }
  removeTrack = (removed: FakeTrack) => {
    this.tracks = this.tracks.filter(candidate => candidate !== removed)
  }
}

type Description = { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp: string }

export class FakePeerConnection {
  static all: FakePeerConnection[] = []
  static last() {
    const last = FakePeerConnection.all.at(-1)
    if (last === undefined) throw new Error('no connection was made')
    return last
  }

  configuration: unknown
  signalingState: 'stable' | 'have-local-offer' | 'have-remote-offer' = 'stable'
  connectionState = 'new'
  localDescription: Description | null = null
  /** Every description of the other end's that was taken in, in order. */
  remote: Description[] = []
  candidates: unknown[] = []
  senders: FakeSender[] = []
  channels: FakeChannel[] = []
  /** What `getStats` reports. */
  stats: Array<Record<string, unknown>> = []
  restarts = 0
  closed = false
  /** Make the next thing of that kind fail, as a browser does with something malformed. */
  refuseDescriptions = false
  refuseCandidates = false
  /** Hold `setLocalDescription` open until `finish()`. */
  slow = false
  private release: (() => void) | null = null
  private made = 0

  onnegotiationneeded: (() => Promise<void> | void) | null = null
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null
  ontrack: ((event: { track: FakeTrack }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null

  constructor(configuration: unknown) {
    this.configuration = configuration
    FakePeerConnection.all.push(this)
  }

  getSenders = () => this.senders
  addTrack = (added: FakeTrack) => {
    const sender: FakeSender = { track: added, replaceTrack: async next => { sender.track = next } }
    this.senders.push(sender)
    return sender
  }
  createDataChannel = (label: string, options: unknown) => {
    const channel = new FakeChannel(label, options)
    this.channels.push(channel)
    return channel
  }
  getStats = async () => new Map(this.stats.map((report, index) => [String(index), report]))

  // With no argument, as the app calls it: an answer to an offer just taken in, or a new offer.
  setLocalDescription = async () => {
    if (this.slow) await new Promise<void>(resolve => { this.release = resolve })
    this.made += 1
    const answering = this.signalingState === 'have-remote-offer'
    this.localDescription = { type: answering ? 'answer' : 'offer', sdp: `${answering ? 'answer' : 'offer'}-${this.made}` }
    this.signalingState = answering ? 'stable' : 'have-local-offer'
  }

  setRemoteDescription = async (description: Description) => {
    if (this.refuseDescriptions) throw new Error('malformed description')
    this.remote.push(description)
    // (An offer taken in over one's own takes one's own back.)
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
  }

  addIceCandidate = async (candidate: unknown) => {
    if (this.refuseCandidates) throw new Error('no description to add it to')
    this.candidates.push(candidate)
  }

  restartIce = () => {
    this.restarts += 1
  }

  close = () => {
    this.closed = true
    this.connectionState = 'closed'
  }

  // ---------- test controls

  /** The browser decides there is something to agree on. */
  negotiate = async () => {
    await this.onnegotiationneeded?.()
  }
  finish = () => {
    this.slow = false
    this.release?.()
  }
  become = (state: string) => {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }
}
