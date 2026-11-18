import type { ComponentProps, ReactNode } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface FieldProps extends ComponentProps<typeof Input> {
  id: string
  label: string
  hint?: ReactNode
}

/** A labelled input with an optional hint, wired together for assistive technology. */
export function Field({ id, label, hint, ...input }: FieldProps) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} aria-describedby={hint === undefined ? undefined : `${id}-hint`} {...input} />
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (message === null) return null
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
