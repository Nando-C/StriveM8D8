import { useId } from 'react'
import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { canChooseSpeaker, type ChosenDevices, type DeviceKind, type Devices } from '@/lib/call/devices'

interface CallSettingsProps {
  devices: Devices
  chosen: ChosenDevices
  onChoose: (kind: DeviceKind, id: string | undefined) => void
  className?: string
}

const KINDS: [DeviceKind, string][] = [['microphone', 'Microphone'], ['camera', 'Camera'], ['speaker', 'Speaker']]

/** Which microphone, camera and speaker the call uses: the browser's own lists, so a phone shows its own picker. */
export function CallSettings({ devices, chosen, onChoose, className }: CallSettingsProps) {
  const id = useId()
  // (A speaker can be chosen only where the browser lets sound be sent to one.)
  const kinds = KINDS.filter(([kind]) => devices[kind].length > 0 && (kind !== 'speaker' || canChooseSpeaker()))
  if (kinds.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-lg" className={className}>
          <Settings aria-hidden="true" />
          <span className="sr-only">Microphone, camera and speaker</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" className="gap-3">
        {kinds.map(([kind, name]) => {
          const list = devices[kind]
          // (One that was chosen and is no longer there: the browser is using whichever it has.)
          const current = list.some(device => device.id === chosen[kind]) ? chosen[kind] : ''
          return (
            <div key={kind} className="flex flex-col gap-1">
              <label htmlFor={`${id}-${kind}`} className="text-xs font-medium text-muted-foreground">{name}</label>
              <select
                id={`${id}-${kind}`}
                value={current}
                onChange={event => onChoose(kind, event.target.value === '' ? undefined : event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Default</option>
                {list.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}
              </select>
            </div>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
