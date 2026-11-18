import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface RecoveryCodeProps {
  code: string
  /** The reader has confirmed they kept the code; it will not be shown again. */
  onSaved: () => void
}

/** Shows a recovery code, once, and does not let go until the reader says they have it. */
export function RecoveryCode({ code, onSaved }: RecoveryCodeProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      // No clipboard access (an insecure page, or permission refused): the code is on
      // screen and can be selected by hand.
      setCopied(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">Save your recovery code</h2>
        <p className="text-sm text-muted-foreground">
          It is the only way back into your account if you forget your password — there is no email address to
          send a reset to. It will not be shown again.
        </p>
      </div>
      <output
        aria-label="Recovery code"
        className="rounded-lg border bg-muted px-3 py-3 text-center font-mono text-base tracking-wider break-all select-all"
      >
        {code}
      </output>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="flex-1" onClick={copy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button type="button" className="flex-1" onClick={onSaved}>
          I’ve saved it
        </Button>
      </div>
    </div>
  )
}
