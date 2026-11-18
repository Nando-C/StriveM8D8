import { useState } from 'react'

type Answer = { ok: true } | { ok: false; message: string }

/**
 * The state every form that asks the server for something goes through: `busy` while the
 * answer is awaited (a second submission is ignored meanwhile), then either `onOk` with
 * the answer or `error` with the server's reason.
 */
export function useRequest() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async <Result extends Answer>(send: () => Promise<Result>, onOk: (answer: Extract<Result, { ok: true }>) => void) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const answer = await send()
    setBusy(false)
    if (answer.ok) onOk(answer as Extract<Result, { ok: true }>)
    else setError(answer.message)
  }

  return { busy, error, run }
}
