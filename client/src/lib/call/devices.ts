// The microphones, cameras and speakers a call may use, and which of each the user chose
// last time — remembered on this device, since the choice is about this device.

export type DeviceKind = 'microphone' | 'camera' | 'speaker'

export interface Device {
  id: string
  label: string
}

export type Devices = Record<DeviceKind, Device[]>
/** The chosen device of each kind, by id. A kind not in it is left to the browser. */
export type ChosenDevices = Partial<Record<DeviceKind, string>>

export const NO_DEVICES: Devices = { microphone: [], camera: [], speaker: [] }

const STORAGE_KEY = 'strive-chat.call-devices'
const KINDS: Record<string, DeviceKind> = { audioinput: 'microphone', videoinput: 'camera', audiooutput: 'speaker' }
const NAMES: Record<DeviceKind, string> = { microphone: 'Microphone', camera: 'Camera', speaker: 'Speaker' }
const MAX_ID_LENGTH = 500

export const chosenDevices = (): ChosenDevices => {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return {}
    const chosen: ChosenDevices = {}
    for (const kind of Object.values(KINDS)) {
      const id = (stored as Record<string, unknown>)[kind]
      if (typeof id === 'string' && id !== '' && id.length <= MAX_ID_LENGTH) chosen[kind] = id
    }
    return chosen
  } catch {
    return {}
  }
}

/** Remembers the choice (`undefined`: leave it to the browser again). Returns all that is now chosen. */
export const chooseDevice = (kind: DeviceKind, id: string | undefined): ChosenDevices => {
  const chosen = chosenDevices()
  if (id === undefined || id === '') delete chosen[kind]
  else chosen[kind] = id
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(chosen))
  } catch {
    // Storage that cannot be written to: the choice lasts as long as the page.
  }
  return chosen
}

/**
 * What the browser can use, by kind. Names are only given once the user has allowed the
 * microphone, so this is asked during a call. (Not every browser lists speakers.)
 */
export const listDevices = async (): Promise<Devices> => {
  const found: Devices = { microphone: [], camera: [], speaker: [] }
  try {
    for (const { kind, deviceId, label } of await navigator.mediaDevices.enumerateDevices()) {
      const ours = KINDS[kind]
      // (No id: the browser is not saying yet. "default" is listed beside the device it stands for.)
      if (ours === undefined || deviceId === '' || deviceId === 'default' || deviceId === 'communications') continue
      if (found[ours].some(device => device.id === deviceId)) continue
      found[ours].push({ id: deviceId, label: label !== '' ? label : `${NAMES[ours]} ${found[ours].length + 1}` })
    }
  } catch {
    // A browser that will not say: there is nothing to choose between.
  }
  return found
}

/** What to ask the browser for: the chosen device if it is still there, else whichever it has. */
export const preferring = (id: string | undefined): MediaTrackConstraints | true => (id === undefined ? true : { deviceId: { ideal: id } })

/** Whether this browser can send the screen. (Phones' browsers cannot.) */
export const canShareScreen = () => typeof navigator.mediaDevices?.getDisplayMedia === 'function'

/** Whether sound can be sent to a speaker of the user's choosing. */
export const canChooseSpeaker = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/** A device held in the hand: one whose cameras look two ways. */
export const isHandheld = () => window.matchMedia?.('(pointer: coarse)').matches === true
