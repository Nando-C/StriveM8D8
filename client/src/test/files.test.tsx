import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatBytes, formatDuration, kindOf } from '@/lib/files'
import { fileUrl, forgetFileUrls } from '@/lib/fileUrls'
import { GIVE_BACK_RETRY_MS, forgetUploadsToGiveBack, giveBackUploads, uploadsCanBeGivenBack } from '@/lib/giveBack'
import type { PreparedFile } from '@/lib/prepareFile'
import {
  chatButton, connectAs, conversation, disconnect, dm, fakeSocket, idOf, loggedInPayload, loginAs, message, messageBox, messages, personButton,
  renderApp, sendButton, serverSays, user,
} from '@/test/harness'
import type { Attachment, Features, Message } from '@/types/protocol'

// Sending, showing and fetching files. Storage is played by the tests: the upload itself
// (`putFile`) and the measuring of a file in the browser (`prepareFile`) are stand-ins,
// and every address is one the fake server "gives out".

const stored = vi.hoisted(() => ({
  put: vi.fn<(url: string, headers: Record<string, string>, body: Blob, options?: { onProgress?: (fraction: number) => void }) => Promise<boolean>>(),
  prepare: vi.fn<(file: File, options?: { original?: boolean }) => Promise<PreparedFile>>(),
}))
vi.mock('@/lib/putFile', () => ({ putFile: stored.put }))
vi.mock('@/lib/prepareFile', () => ({ prepareFile: stored.prepare, MAX_IMAGE_WIDTH: 2560 }))

const BOB = dm('alice', 'bob')
const MB = 1024 * 1024
const FILES: Features = { files: true, maxFileBytes: 25 * MB, maxFilesPerMessage: 10 }
const answer = (event: string, response: object) => act(() => fakeSocket.last(event).ack?.(response))
const fileId = (n: number) => `3f0e6c1a-0000-4000-8000-${String(n).padStart(12, '0')}`

beforeEach(() => {
  forgetFileUrls()
  forgetUploadsToGiveBack()
  stored.put.mockReset().mockResolvedValue(true)
  stored.prepare.mockReset().mockImplementation(async file => ({
    blob: file, name: file.name, type: file.type || 'application/octet-stream', size: file.size, resized: false,
  }))
})

/** Alice with bob's conversation open — as an account or a guest, on a deployment with or without files. */
const open = async ({ kind = 'account', features = FILES as Features | null, admin = false, history = [] as Message[] } = {}) => {
  renderApp()
  const events = await loginAs('alice', [user('bob')])
  // The same person, back after a dropped connection, as the server describes them this time.
  disconnect()
  connectAs('socket-2')
  serverSays('loggedin', { ...loggedInPayload('alice', [user('bob')], 'token-2'), kind: kind as 'account' | 'guest', admin, ...(features ? { features } : {}) })
  await events.click(personButton('bob'))
  if (history.length > 0) {
    serverSays('conversationUpdated', { conversation: conversation('alice', 'bob', { last: history.at(-1) }) })
    serverSays('history', { conversationId: BOB, messages: history, hasMore: false })
  }
  return events
}
const picker = () => screen.getByLabelText('Choose files to send')
const choose = (...files: File[]) => fireEvent.change(picker(), { target: { files } })
const png = (name = 'holiday.png', size = 2048) => new File([new Uint8Array(size)], name, { type: 'image/png' })
const chips = () => within(screen.getByRole('list', { name: 'Files to send' })).getAllByRole('listitem')
const reserved = (n: number) => ({ ok: true, fileId: fileId(n), uploadUrl: `https://storage.test/put/${n}`, headers: { 'Content-Type': 'image/png' }, expiresInSeconds: 900 })

const attachment = (n: number, overrides: Partial<Attachment> = {}): Attachment => ({
  id: fileId(n), name: `photo-${n}.png`, type: 'image/png', size: 2048, width: 640, height: 480, ...overrides,
})
const withFiles = (n: number, from: string, files: Attachment[], text = ''): Message =>
  message(from, from === 'alice' ? 'bob' : 'alice', text, { id: n.toString(16).padStart(24, '0'), timestamp: n * 1000, attachments: files })
/** Answers every address that has been asked for and not answered yet. */
const giveUrls = () => act(() => {
  for (const entry of fakeSocket.emitted) {
    if (entry.event !== 'getFileUrl' || entry.ack === undefined) continue
    const { fileId: id, download } = entry.payload as { fileId: string; download?: boolean }
    entry.ack({ ok: true, url: `https://storage.test/${download ? 'save' : 'get'}/${id}`, expiresInSeconds: 300 })
    entry.ack = undefined
  }
})

describe('attaching files', () => {
  it('is not offered where the deployment has no file sharing, and is for accounts where it has', async () => {
    await open({ features: null })
    expect(screen.queryByRole('button', { name: /Attach files|account to send files/ })).not.toBeInTheDocument()
  })

  it('tells a guest that sending files needs an account', async () => {
    await open({ kind: 'guest' })
    expect(screen.getByRole('button', { name: 'Create an account to send files' })).toBeDisabled()
  })

  it('gives back the places of its files when the message is refused — not when there is simply no answer', async () => {
    const events = await open()
    const attachOne = async (n: number) => {
      choose(png())
      await waitFor(() => expect(fakeSocket.sent('requestUpload')).toHaveLength(n))
      answer('requestUpload', reserved(n))
      await waitFor(() => expect(sendButton()).toBeEnabled())
    }
    // No answer says nothing: the message may yet go (it is only slow), and keeps its files.
    await attachOne(1)
    vi.useFakeTimers()
    try {
      fireEvent.click(sendButton())
      await act(async () => vi.advanceTimersByTime(60_000))
    } finally {
      vi.useRealTimers()
    }
    expect(fakeSocket.sent('sendmessage')).toHaveLength(1)
    expect(fakeSocket.sent('cancelUpload')).toEqual([])

    await attachOne(2)
    await events.click(sendButton())
    expect(fakeSocket.sent('cancelUpload')).toEqual([])

    answer('sendmessage', { ok: false, message: 'You are sending messages too quickly' })
    // Nothing is left waiting on the server, in the way of attaching something else.
    await waitFor(() => expect(fakeSocket.sent('cancelUpload')).toEqual([{ fileId: fileId(2) }]))
    expect(screen.getByRole('log')).toHaveTextContent('You are sending messages too quickly')

  })

  it('goes on trying to give them back until it has been done — but only while logged in, and never twice at once', async () => {
    await open()
    const asked = () => fakeSocket.sent('cancelUpload')
    vi.useFakeTimers()
    try {
      // The connection is down: nothing is sent.
      disconnect()
      giveBackUploads([fileId(7)])
      expect(asked()).toEqual([])
      // Logged in again: now it is.
      uploadsCanBeGivenBack(idOf('alice'), true)
      expect(asked()).toEqual([{ fileId: fileId(7) }])
      // Not asked again while that is unanswered, whatever else is given back meanwhile.
      giveBackUploads([fileId(8)])
      expect(asked()).toEqual([{ fileId: fileId(7) }, { fileId: fileId(8) }])
      await act(async () => fakeSocket.emitted.filter(entry => entry.event === 'cancelUpload')[0].ack?.({ ok: false, message: 'Slow down', retryable: true }))
      await answer('cancelUpload', { ok: true })
      expect(asked()).toHaveLength(2)

      // Turned away for now: asked again by itself, a while later.
      await act(async () => vi.advanceTimersByTime(GIVE_BACK_RETRY_MS))
      expect(asked()).toEqual([{ fileId: fileId(7) }, { fileId: fileId(8) }, { fileId: fileId(7) }])
      // Done — or not there to be given back, which comes to the same: not asked again.
      await answer('cancelUpload', { ok: false, message: 'Unknown file' })
      await act(async () => vi.advanceTimersByTime(3 * GIVE_BACK_RETRY_MS))
      expect(asked()).toHaveLength(3)

      // What one user left behind is not asked for in the next one's name.
      uploadsCanBeGivenBack(idOf('alice'), false)
      giveBackUploads([fileId(9)])
      uploadsCanBeGivenBack(idOf('carol'), true)
      expect(asked()).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a chosen picture in its chip before it is sent, straight from the device', async () => {
    const create = vi.fn(() => 'blob:preview-1')
    const revoke = vi.fn()
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    try {
      const events = await open()
      stored.put.mockImplementationOnce(() => new Promise(() => {}))
      choose(png())
      await waitFor(() => expect(chips()).toHaveLength(1))
      expect(chips()[0].querySelector('img')).toHaveAttribute('src', 'blob:preview-1')
      // Nothing was asked of the server for it.
      expect(fakeSocket.sent('getFileUrl')).toHaveLength(0)

      // Taken out again: the address is given back.
      await events.click(within(chips()[0]).getByRole('button', { name: /^Remove / }))
      await waitFor(() => expect(screen.queryByRole('list', { name: 'Files to send' })).not.toBeInTheDocument())
      expect(revoke).toHaveBeenCalledWith('blob:preview-1')
    } finally {
      Object.assign(URL, { createObjectURL: original.create, revokeObjectURL: original.revoke })
    }
  })

  it('uploads a chosen file straight away, and sends it with the message', async () => {
    const events = await open()
    stored.prepare.mockResolvedValueOnce({ blob: png(), name: 'holiday.png', type: 'image/png', size: 2048, width: 640, height: 480, placeholder: 'data:image/webp;base64,AAAA', resized: false })
    let progress: ((fraction: number) => void) | undefined
    let finish: (ok: boolean) => void = () => {}
    stored.put.mockImplementationOnce((_url, _headers, _body, options) => {
      progress = options?.onProgress
      return new Promise(resolve => { finish = resolve })
    })

    choose(png())
    await waitFor(() => expect(fakeSocket.sent('requestUpload')).toHaveLength(1))
    // What the server is told about the file — and nothing of its contents.
    expect(fakeSocket.last('requestUpload').payload).toEqual({
      conversationId: BOB, name: 'holiday.png', type: 'image/png', size: 2048, width: 640, height: 480, placeholder: 'data:image/webp;base64,AAAA',
    })
    expect(chips()[0]).toHaveTextContent('holiday.png')
    // Nothing can be sent until the file has arrived.
    await events.type(messageBox('bob'), 'look at this')
    expect(sendButton()).toBeDisabled()

    answer('requestUpload', reserved(1))
    await waitFor(() => expect(stored.put).toHaveBeenCalledWith('https://storage.test/put/1', { 'Content-Type': 'image/png' }, expect.any(Blob), expect.anything()))
    act(() => progress?.(0.4))
    expect(chips()[0]).toHaveTextContent('Uploading… 40%')
    expect(within(chips()[0]).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    await act(async () => finish(true))
    await waitFor(() => expect(chips()[0]).toHaveTextContent('2.0 kB'))

    await events.click(sendButton())
    expect(fakeSocket.last('sendmessage').payload).toEqual({
      conversationId: BOB, text: 'look at this', clientId: expect.any(String), attachments: [fileId(1)],
    })
    // The chips are done with, and the message is on screen with its picture.
    expect(screen.queryByRole('list', { name: 'Files to send' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View holiday.png' })).toBeInTheDocument()
    expect(screen.getByRole('log')).toHaveTextContent('look at this')
    // It was sent: nothing is taken back.
    expect(fakeSocket.sent('cancelUpload')).toEqual([])

    // Its picture is fetched only once the message is saved: before that the server has no address to give.
    expect(fakeSocket.sent('getFileUrl')).toEqual([])
    answer('sendmessage', { ok: true, id: '0'.repeat(23) + '9', timestamp: Date.now() })
    await waitFor(() => expect(fakeSocket.sent('getFileUrl')).toEqual([{ fileId: fileId(1) }]))
    giveUrls()
    await waitFor(() => expect(screen.getByRole('img', { name: 'holiday.png' })).toHaveAttribute('src', `https://storage.test/get/${fileId(1)}`))
  })

  it('can send files alone, and several at once', async () => {
    const events = await open()
    choose(png('one.png'), png('two.png'))
    await waitFor(() => expect(fakeSocket.sent('requestUpload')).toHaveLength(2))
    act(() => {
      const asked = fakeSocket.emitted.filter(entry => entry.event === 'requestUpload')
      asked.forEach((entry, index) => entry.ack?.(reserved(index + 1)))
    })
    await waitFor(() => expect(sendButton()).toBeEnabled())
    await events.click(sendButton())
    expect(fakeSocket.last('sendmessage').payload).toMatchObject({ text: '', attachments: [fileId(1), fileId(2)] })
  })

  it('shows why a file was refused, and lets it be tried again or removed', async () => {
    const events = await open()
    choose(png())
    await waitFor(() => expect(fakeSocket.sent('requestUpload')).toHaveLength(1))
    answer('requestUpload', { ok: false, message: 'You have reached your upload limit for today' })
    await waitFor(() => expect(chips()[0]).toHaveTextContent('You have reached your upload limit for today'))
    expect(sendButton()).toBeDisabled()

    await events.click(screen.getByRole('button', { name: 'Try holiday.png again' }))
    await waitFor(() => expect(fakeSocket.sent('requestUpload')).toHaveLength(2))
    // This time storage does not take it.
    stored.put.mockResolvedValueOnce(false)
    answer('requestUpload', reserved(2))
    await waitFor(() => expect(chips()[0]).toHaveTextContent('The upload did not finish'))
    // Its place is given back.
    expect(fakeSocket.sent('cancelUpload')).toEqual([{ fileId: fileId(2) }])

    await events.click(screen.getByRole('button', { name: 'Remove holiday.png' }))
    expect(screen.queryByRole('list', { name: 'Files to send' })).not.toBeInTheDocument()
    // With nothing attached, words alone can go again.
    await events.type(messageBox('bob'), 'never mind')
    expect(sendButton()).toBeEnabled()
  })

  it('gives back the place of a file that was uploaded and then removed', async () => {
    const events = await open()
    choose(png())
    await waitFor(() => expect(fakeSocket.sent('requestUpload')).toHaveLength(1))
    answer('requestUpload', reserved(1))
    await waitFor(() => expect(sendButton()).toBeEnabled())
    await events.click(screen.getByRole('button', { name: 'Remove holiday.png' }))
    expect(fakeSocket.sent('cancelUpload')).toEqual([{ fileId: fileId(1) }])
  })

  it('does not ask the server about a file it already knows is too large', async () => {
    await open({ features: { ...FILES, maxFileBytes: 1000 } })
    choose(png('huge.png', 1001))
    await waitFor(() => expect(chips()[0]).toHaveTextContent('Too large — a file can be at most 1000 B'))
    expect(fakeSocket.sent('requestUpload')).toEqual([])
  })

  it('takes five files for one message, and says so when given more', async () => {
    await open()
    choose(...Array.from({ length: 7 }, (_, index) => png(`${index}.png`)))
    await waitFor(() => expect(chips()).toHaveLength(5))
    expect(screen.getByText('A message can carry 5 files: the rest were left out')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled()
  })

  it('takes files pasted into the message, and files dropped onto the conversation', async () => {
    await open()
    fireEvent.paste(messageBox('bob'), { clipboardData: { files: [png('pasted.png')] } })
    await waitFor(() => expect(chips()).toHaveLength(1))

    const area = screen.getByRole('log').closest('div.relative') as HTMLElement
    fireEvent.dragEnter(area, { dataTransfer: { types: ['Files'], files: [] } })
    expect(screen.getByText('Drop files to send them')).toBeInTheDocument()
    fireEvent.drop(area, { dataTransfer: { types: ['Files'], files: [png('dropped.png')] } })
    await waitFor(() => expect(chips()).toHaveLength(2))
    expect(screen.queryByText('Drop files to send them')).not.toBeInTheDocument()
    expect(chips().map(chip => chip.textContent)).toEqual([expect.stringContaining('pasted.png'), expect.stringContaining('dropped.png')])
  })

  it('offers the original of a picture that is being sent smaller', async () => {
    const events = await open()
    stored.prepare.mockResolvedValueOnce({ blob: png('big.png', 500), name: 'big.png', type: 'image/png', size: 500, width: 2560, height: 1440, resized: true })
    choose(png('big.png', 9000))
    await waitFor(() => expect(fakeSocket.sent('requestUpload')).toHaveLength(1))
    answer('requestUpload', reserved(1))
    await waitFor(() => expect(chips()[0]).toHaveTextContent('500 B · made smaller'))

    await events.click(screen.getByRole('checkbox', { name: 'Send original' }))
    // The smaller copy is taken back, and the file goes again as it is.
    await waitFor(() => expect(fakeSocket.sent('requestUpload')).toHaveLength(2))
    expect(fakeSocket.sent('cancelUpload')).toEqual([{ fileId: fileId(1) }])
    expect(stored.prepare).toHaveBeenLastCalledWith(expect.any(File), { original: true })
    expect(fakeSocket.last('requestUpload').payload).toMatchObject({ size: 9000 })
  })
})

describe('files in a conversation', () => {
  it('shows each kind as what it is: pictures in a grid, video and sound to play, the rest to download', async () => {
    await open({
      history: [withFiles(1, 'bob', [
        attachment(1),
        attachment(2, { name: 'clip.webm', type: 'video/webm', durationMs: 65_000 }),
        attachment(3, { name: 'voice.mp3', type: 'audio/mpeg', width: undefined, height: undefined, durationMs: 9000 }),
        attachment(4, { name: 'notes.pdf', type: 'application/pdf', size: 340_000, width: undefined, height: undefined }),
        // A picture this browser cannot show is a file to download, not a broken picture.
        attachment(5, { name: 'IMG_0001.HEIC', type: 'image/heic', size: 3 * MB }),
      ], 'from the trip')],
    })
    const log = screen.getByRole('log')
    expect(log.querySelectorAll('[data-attachment]')).toHaveLength(5)
    expect(log).toHaveTextContent('from the trip')
    // An address is asked for each thing that is shown in the page — not for what is only offered.
    expect(fakeSocket.sent<{ fileId: string }>('getFileUrl').map(asked => asked.fileId).sort()).toEqual([fileId(1), fileId(2), fileId(3)])
    giveUrls()

    await waitFor(() => expect(within(log).getByRole('img', { name: 'photo-1.png' })).toHaveAttribute('src', `https://storage.test/get/${fileId(1)}`))
    const video = log.querySelector('video')
    // (With a moment asked for, so that its first frame is shown before it is played.)
    expect(video).toHaveAttribute('src', `https://storage.test/get/${fileId(2)}#t=0.001`)
    expect(video).toHaveAttribute('preload', 'metadata')
    expect(log.querySelector('audio')).toHaveAttribute('preload', 'metadata')
    expect(log).toHaveTextContent('voice.mp3 · 0:09')
    expect(log).toHaveTextContent('notes.pdf332 kB')
    expect(log).toHaveTextContent('IMG_0001.HEIC3.0 MB')
    expect(within(log).queryByRole('img', { name: 'IMG_0001.HEIC' })).not.toBeInTheDocument()
  })

  it('shows four pictures of a message and says how many more there are', async () => {
    await open({ history: [withFiles(1, 'bob', Array.from({ length: 6 }, (_, index) => attachment(index + 1)))] })
    expect(screen.getAllByRole('button', { name: /^View photo-/ })).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'View photo-4.png' })).toHaveTextContent('+2')
  })

  it('asks for a fresh address when a picture fails to load, and falls back to a download if that fails too', async () => {
    await open({ history: [withFiles(1, 'bob', [attachment(1)])] })
    giveUrls()
    const picture = () => screen.getByRole('img', { name: 'photo-1.png' })
    await waitFor(() => expect(picture()).toBeInTheDocument())

    fireEvent.error(picture())
    await waitFor(() => expect(fakeSocket.sent('getFileUrl')).toHaveLength(2))
    giveUrls()
    await waitFor(() => expect(picture()).toBeInTheDocument())
    fireEvent.error(picture())

    await waitFor(() => expect(screen.getByRole('button', { name: 'Download photo-1.png' })).toBeInTheDocument())
    expect(screen.queryByRole('img', { name: 'photo-1.png' })).not.toBeInTheDocument()
  })

  it('carries a video on from where it was when its address lapses, however often — but gives up on one that keeps failing', async () => {
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    await open({ history: [withFiles(1, 'bob', [attachment(1, { name: 'film.mp4', type: 'video/mp4' })])] })
    giveUrls()
    const video = () => screen.getByRole('log').querySelector('video') as HTMLVideoElement
    await waitFor(() => expect(video()).toHaveAttribute('src'))
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    /** The video stops at `seconds`, having been on screen for `watchedMs`; it is then given a fresh address. */
    const failAt = async (seconds: number, watchedMs: number, asked: number, { paused = false } = {}) => {
      const before = video()
      clock += watchedMs
      Object.defineProperty(before, 'currentTime', { value: seconds, writable: true })
      Object.defineProperty(before, 'paused', { value: paused })
      fireEvent.error(before)
      // Nothing is played from the dead address meanwhile.
      await waitFor(() => expect(screen.getByRole('log').querySelector('video')).toBeNull())
      await waitFor(() => expect(fakeSocket.sent('getFileUrl')).toHaveLength(asked))
      giveUrls()
      await waitFor(() => expect(video()).not.toBeNull())
      const after = video()
      Object.defineProperty(after, 'currentTime', { value: 0, writable: true })
      fireEvent.loadedMetadata(after)
      expect(after.currentTime).toBe(seconds)
    }
    const FIVE_MINUTES = 5 * 60_000
    // Watched for a quarter of an hour: three addresses lapse on the way.
    await failAt(290, FIVE_MINUTES, 2)
    await failAt(580, FIVE_MINUTES, 3)
    await failAt(870, FIVE_MINUTES, 4)
    expect(play).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('button', { name: 'Download film.mp4' })).not.toBeInTheDocument()

    // Paused when the address lapses: it carries on from the same place, still paused.
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    await failAt(900, FIVE_MINUTES, 5, { paused: true })
    expect(play).toHaveBeenCalledTimes(3)
    expect(pause).toHaveBeenCalled()
    await failAt(900, FIVE_MINUTES, 6)

    // A piece of it cannot be played at all: it fails again as soon as it is tried again —
    // and then it is something to download, not something tried for ever.
    clock += 2000
    fireEvent.error(video())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download film.mp4' })).toBeInTheDocument())
    expect(fakeSocket.sent('getFileUrl')).toHaveLength(6)
  })

  it('downloads a file through an address that saves it', async () => {
    const events = await open({ history: [withFiles(1, 'bob', [attachment(1, { name: 'report.zip', type: 'application/zip' })])] })
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await events.click(screen.getByRole('button', { name: 'Download report.zip' }))
    expect(fakeSocket.last('getFileUrl').payload).toEqual({ fileId: fileId(1), download: true })
    giveUrls()
    await waitFor(() => expect(clicked).toHaveBeenCalledOnce())

    // Refused: said on the card.
    await events.click(screen.getByRole('button', { name: 'Download report.zip' }))
    answer('getFileUrl', { ok: false, message: 'Unknown file' })
    expect(await screen.findByText('Could not be downloaded — try again')).toBeInTheDocument()
  })

  it('names a message of files alone in the chat list', async () => {
    renderApp()
    const sent = withFiles(1, 'bob', [attachment(1), attachment(2)])
    await loginAs('alice', [user('bob')], [{
      ...conversation('alice', 'bob', { last: sent }),
      lastMessage: { id: sent.id, from: sent.from, fromName: 'bob', preview: '', timestamp: 1000, attachments: 2 },
    }])
    expect(chatButton('bob')).toHaveTextContent('2 files')
    serverSays('message', withFiles(2, 'bob', [attachment(3)]))
    await waitFor(() => expect(chatButton('bob')).toHaveTextContent('1 file'))
  })
})

describe('looking at a file full size', () => {
  const history = [
    withFiles(1, 'bob', [attachment(1)]),
    withFiles(2, 'alice', [attachment(2, { name: 'clip.webm', type: 'video/webm' }), attachment(3, { name: 'notes.pdf', type: 'application/pdf' })]),
    withFiles(3, 'bob', [attachment(4)]),
  ]

  it('opens a picture over the conversation, and steps through the pictures and videos with the arrow keys', async () => {
    const events = await open({ history })
    giveUrls()
    await events.click(screen.getByRole('button', { name: 'View photo-1.png' }))
    const viewer = await screen.findByRole('dialog', { name: 'photo-1.png' })
    expect(viewer).toHaveTextContent('1 of 3')
    await waitFor(() => expect(within(viewer).getByRole('img', { name: 'photo-1.png' })).toHaveAttribute('src', `https://storage.test/get/${fileId(1)}`))
    // The first has nothing before it.
    expect(within(viewer).queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument()

    await events.keyboard('{ArrowRight}')
    const second = await screen.findByRole('dialog', { name: 'clip.webm' })
    expect(second).toHaveTextContent('2 of 3')
    await waitFor(() => expect(second.querySelector('video')).toHaveAttribute('src', `https://storage.test/get/${fileId(2)}`))
    // The PDF is not one of them.
    await events.click(within(second).getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('dialog', { name: 'photo-4.png' })).toHaveTextContent('3 of 3')
    await events.keyboard('{ArrowRight}')
    expect(screen.getByRole('dialog', { name: 'photo-4.png' })).toBeInTheDocument()
    await events.keyboard('{ArrowLeft}')
    expect(await screen.findByRole('dialog', { name: 'clip.webm' })).toBeInTheDocument()

    await events.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('shows nothing of the file before while the next one is being fetched', async () => {
    const events = await open({ history })
    giveUrls()
    await events.click(screen.getByRole('button', { name: 'View photo-1.png' }))
    const viewer = await screen.findByRole('dialog', { name: 'photo-1.png' })
    await waitFor(() => expect(within(viewer).getByRole('img', { name: 'photo-1.png' })).toHaveAttribute('src'))
    // (As when the next file's address has lapsed, or was never asked for.)
    forgetFileUrls()

    await events.keyboard('{ArrowRight}')
    const second = await screen.findByRole('dialog', { name: 'clip.webm' })
    expect(second).toHaveTextContent('Loading…')
    expect(second.querySelector('video, img')).toBeNull()
    giveUrls()
    await waitFor(() => expect(second.querySelector('video')).toHaveAttribute('src', `https://storage.test/get/${fileId(2)}`))

    // A file that cannot be shown says so — and the one after it is shown all the same.
    fireEvent.error(second.querySelector('video') as HTMLVideoElement)
    await waitFor(() => expect(fakeSocket.sent('getFileUrl').length).toBeGreaterThan(0))
    giveUrls()
    await waitFor(() => expect(second.querySelector('video')).not.toBeNull())
    fireEvent.error(second.querySelector('video') as HTMLVideoElement)
    await waitFor(() => expect(second).toHaveTextContent('This file cannot be shown here'))
    forgetFileUrls()
    await events.keyboard('{ArrowRight}')
    const third = await screen.findByRole('dialog', { name: 'photo-4.png' })
    giveUrls()
    await waitFor(() => expect(within(third).getByRole('img', { name: 'photo-4.png' })).toHaveAttribute('src', `https://storage.test/get/${fileId(4)}`))
  })

  it('opens a PDF in the page, with a way to download it', async () => {
    const events = await open({ history })
    giveUrls()
    await events.click(screen.getByRole('button', { name: 'Open notes.pdf' }))
    const viewer = await screen.findByRole('dialog', { name: 'notes.pdf' })
    giveUrls()
    await waitFor(() => expect(within(viewer).getByTitle('notes.pdf')).toHaveAttribute('src', `https://storage.test/get/${fileId(3)}`))
    expect(within(viewer).queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()

    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await events.click(within(viewer).getByRole('button', { name: 'Download' }))
    expect(fakeSocket.last('getFileUrl').payload).toEqual({ fileId: fileId(3), download: true })
    giveUrls()
    await waitFor(() => expect(clicked).toHaveBeenCalledOnce())
  })
})

describe('deleting one’s own message', () => {
  const said = (n: number, from: string, text: string) =>
    message(from, from === 'alice' ? 'bob' : 'alice', text, { id: n.toString(16).padStart(24, '0'), timestamp: n * 1000 })

  it('asks first, then asks the server — and the message goes when the server says so', async () => {
    const events = await open({ history: [said(1, 'bob', 'from bob'), said(2, 'alice', 'oops')] })
    // Only one's own messages can be deleted.
    expect(screen.getAllByRole('button', { name: 'Delete this message' })).toHaveLength(1)

    await events.click(screen.getByRole('button', { name: 'Delete this message' }))
    const confirm = await screen.findByRole('dialog')
    expect(confirm).toHaveTextContent('Delete this message for everyone?')
    await events.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(fakeSocket.sent('deleteMessage')).toEqual([])

    await events.click(screen.getByRole('button', { name: 'Delete this message' }))
    await events.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(fakeSocket.last('deleteMessage').payload).toEqual({ id: said(2, 'alice', '').id })
    // Nothing is changed in advance.
    expect(messages()).toEqual(['from bob', 'oops'])

    serverSays('messageDeleted', { conversationId: BOB, id: said(2, 'alice', '').id })
    answer('deleteMessage', { ok: true })
    await waitFor(() => expect(messages()).toEqual(['from bob', 'You deleted a message']))
    expect(screen.queryByRole('button', { name: 'Delete this message' })).not.toBeInTheDocument()
  })

  it('says why if the server refuses', async () => {
    const events = await open({ history: [said(1, 'alice', 'oops')] })
    await events.click(screen.getByRole('button', { name: 'Delete this message' }))
    await events.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    answer('deleteMessage', { ok: false, message: 'Unknown message' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown message')
    expect(messages()).toEqual(['oops'])
  })
})

describe('how full storage is', () => {
  it('is shown to an administrator in the account menu', async () => {
    const events = await open({ admin: true })
    await events.click(screen.getByRole('button', { name: 'Account menu for alice' }))
    expect(fakeSocket.sent('getStorageUsage')).toEqual([{}])
    answer('getStorageUsage', { ok: true, usedBytes: 1.5 * 1024 * MB, maxBytes: 9000 * MB, files: 12 })
    expect(await screen.findByText(/Storage: 1\.5 GB of 8\.8 GB used · 12 files/)).toBeInTheDocument()
  })

  it('is not asked for by anyone else', async () => {
    const events = await open()
    await events.click(screen.getByRole('button', { name: 'Account menu for alice' }))
    expect(fakeSocket.sent('getStorageUsage')).toEqual([])
  })
})

describe('the address of a file', () => {
  it('is asked for once, kept until shortly before it lapses, and then asked for again', async () => {
    vi.useFakeTimers()
    try {
      const ask = () => fileUrl(fileId(1))
      const first = ask()
      const again = ask()
      expect(fakeSocket.sent('getFileUrl')).toHaveLength(1)
      fakeSocket.last('getFileUrl').ack?.({ ok: true, url: 'https://storage.test/get/1', expiresInSeconds: 300 })
      expect(await Promise.all([first, again])).toEqual(['https://storage.test/get/1', 'https://storage.test/get/1'])

      vi.advanceTimersByTime(4 * 60_000)
      expect(await ask()).toBe('https://storage.test/get/1')
      expect(fakeSocket.sent('getFileUrl')).toHaveLength(1)
      // Half a minute before it lapses it is no longer handed out.
      vi.advanceTimersByTime(31_000)
      void ask()
      expect(fakeSocket.sent('getFileUrl')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('saying what a file is', () => {
  it('sizes, lengths and kinds', () => {
    expect([0, 999, 1024, 1536, 340_000, 3 * MB, 25 * MB, 1.5 * 1024 * MB].map(formatBytes))
      .toEqual(['0 B', '999 B', '1.0 kB', '1.5 kB', '332 kB', '3.0 MB', '25 MB', '1.5 GB'])
    expect([9000, 65_000, 3_723_000].map(formatDuration)).toEqual(['0:09', '1:05', '1:02:03'])
    expect(['image/png', 'image/heic', 'image/svg+xml', 'video/webm', 'video/quicktime', 'audio/mpeg', 'application/pdf', 'text/html'].map(kindOf))
      .toEqual(['image', 'file', 'file', 'video', 'video', 'audio', 'pdf', 'file'])
  })
})
