import { render, screen } from '@testing-library/react'
import { useReducedMotionConfig } from 'motion/react'
import { expect, it } from 'vitest'
import { AppProviders } from '@/components/AppProviders'

// The counterpart of reduced-motion.test.tsx, separate for the same reason.

function Probe() {
  return <output>{String(useReducedMotionConfig())}</output>
}

it('leaves motion on when the system has no reduced-motion preference', () => {
  render(
    <AppProviders>
      <Probe />
    </AppProviders>,
  )

  expect(screen.getByRole('status')).toHaveTextContent('false')
})
