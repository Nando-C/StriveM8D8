import { render, screen } from '@testing-library/react'
import { useReducedMotionConfig } from 'motion/react'
import { expect, it } from 'vitest'
import { AppProviders } from '@/components/AppProviders'
import { mediaQueries } from '@/test/setup'

// In a file of its own: Motion reads the system preference once, the first time anything
// animated renders, so the preference has to be in place before any other test renders.

function Probe() {
  return <output>{String(useReducedMotionConfig())}</output>
}

it('turns reduced motion on for the whole app when the system asks for it', () => {
  mediaQueries.reducedMotion = true

  render(
    <AppProviders>
      <Probe />
    </AppProviders>,
  )

  expect(screen.getByRole('status')).toHaveTextContent('true')
})
