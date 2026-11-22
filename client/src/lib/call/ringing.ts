// How a call makes itself noticed: a ringtone, made here rather than played from a file,
// and the tab's title changing — for someone looking at another tab.

type AudioContextClass = typeof AudioContext

const audioContextClass = (): AudioContextClass | undefined =>
  window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext

// One source of sound for as long as the page lives. A browser keeps a page silent until
// the user has touched it, and some (Safari) let the sound be woken only *while* it is
// being touched — so it is woken at every touch, not when a call happens to ring.
let shared: AudioContext | null | undefined

const soundContext = (): AudioContext | null => {
  if (shared !== undefined) return shared
  const Context = audioContextClass()
  try {
    shared = Context === undefined ? null : new Context()
  } catch {
    shared = null
  }
  return shared
}

const wake = () => {
  const context = soundContext()
  // (Not only 'suspended': a phone that put the page aside leaves it 'interrupted'.)
  if (context !== null && context.state !== 'running') void context.resume().catch(() => {})
}

const TOUCHES = ['pointerdown', 'keydown', 'touchend'] as const

/** Lets the page make sound from the user's first touch on. Returns what undoes it. */
export const allowSound = (): (() => void) => {
  for (const touch of TOUCHES) document.addEventListener(touch, wake, { capture: true, passive: true })
  return () => {
    for (const touch of TOUCHES) document.removeEventListener(touch, wake, { capture: true })
  }
}

interface Ring {
  /** Each note: its pitch, when it starts within the ring, how long it lasts (seconds). */
  notes: readonly (readonly [frequency: number, at: number, length: number])[]
  loudness: number
  everyMs: number
}

const RINGS = {
  /** Someone is calling: two short rising notes, a pause, again. */
  incoming: { notes: [[660, 0, 0.4], [880, 0.45, 0.4]], loudness: 0.15, everyMs: 2500 },
  /** It is ringing at the other end: one long, quiet note, as on a telephone. */
  outgoing: { notes: [[440, 0, 1]], loudness: 0.06, everyMs: 3000 },
} satisfies Record<string, Ring>

/** Rings until what it returns is called. Silent where, or for as long as, sound cannot be made. */
export const startRingtone = (kind: keyof typeof RINGS = 'incoming'): (() => void) => {
  const context = soundContext()
  if (context === null) return () => {}
  const { notes, loudness, everyMs }: Ring = RINGS[kind]
  // (Everything goes through this, so that stopping cuts a note short.)
  const out = context.createGain()
  out.connect(context.destination)
  const ring = () => {
    if (context.state !== 'running') {
      // Not allowed yet. (Notes are not lined up meanwhile: time stands still in a
      // context that is not running, and they would all sound at once when it starts.)
      void context.resume().catch(() => {})
      return
    }
    const now = context.currentTime
    for (const [frequency, at, length] of notes) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.frequency.value = frequency
      // (Faded in and out: a tone cut off square clicks.)
      gain.gain.setValueAtTime(0, now + at)
      gain.gain.linearRampToValueAtTime(loudness, now + at + 0.03)
      gain.gain.linearRampToValueAtTime(0, now + at + length - 0.05)
      oscillator.connect(gain).connect(out)
      oscillator.start(now + at)
      oscillator.stop(now + at + length)
    }
  }
  ring()
  // (Looked at often, rung seldom: it starts within a moment of being allowed to.)
  let rungAt = context.state === 'running' ? Date.now() : null
  const repeating = setInterval(() => {
    if (rungAt !== null && Date.now() - rungAt < everyMs) return
    ring()
    if (context.state === 'running') rungAt = Date.now()
  }, 250)
  return () => {
    clearInterval(repeating)
    out.disconnect()
  }
}

/**
 * Alternates the tab's title with `notice`. Returns what puts it back. The title under
 * the notice may change meanwhile (a message arrives, and is counted there): whatever it
 * was last set to by someone else is what is alternated with, and what is left at the end.
 */
export const flashTitle = (notice: string): (() => void) => {
  let under = document.title
  let shown = false
  const flip = () => {
    if (document.title !== notice) under = document.title
    shown = !shown
    document.title = shown ? notice : under
  }
  flip()
  const repeating = setInterval(flip, 1000)
  return () => {
    clearInterval(repeating)
    // (If it is not the notice that is there, someone has just set it: theirs stays.)
    if (document.title === notice) document.title = under
  }
}
