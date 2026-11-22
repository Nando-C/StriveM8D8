// How an incoming call makes itself noticed: a ringtone, made here rather than played
// from a file, and the tab's title changing — for someone looking at another tab.

type AudioContextClass = typeof AudioContext

const audioContextClass = (): AudioContextClass | undefined =>
  window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext

/** Two short notes, a pause, again. Returns what stops it. Silent where sound cannot be made. */
export const startRingtone = (): (() => void) => {
  const Context = audioContextClass()
  if (Context === undefined) return () => {}
  let context: AudioContext
  try {
    context = new Context()
  } catch {
    return () => {}
  }
  const note = (frequency: number, at: number) => {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = frequency
    // (Faded in and out: a tone cut off square clicks.)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.15, at + 0.03)
    gain.gain.linearRampToValueAtTime(0, at + 0.35)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(at)
    oscillator.stop(at + 0.4)
  }
  const ring = () => {
    // A browser keeps sound off until the user has done something on the page; it rings from then on.
    void context.resume().catch(() => {})
    const now = context.currentTime
    note(660, now)
    note(880, now + 0.45)
  }
  ring()
  const repeating = setInterval(ring, 2500)
  return () => {
    clearInterval(repeating)
    void context.close().catch(() => {})
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
