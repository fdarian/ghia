import { describe, expect, it } from 'vitest'
import { Collapsible } from '@photon-ai/base-ui-solid/collapsible'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { click, exists, focus, mount, press, query } from '../kobalte/harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onOpenChange?: (open: boolean) => void; defaultOpen?: boolean }) {
  return (
    <Collapsible.Root defaultOpen={props.defaultOpen} onOpenChange={props.onOpenChange}>
      <Collapsible.Trigger>Toggle</Collapsible.Trigger>
      <Collapsible.Panel>Hidden text</Collapsible.Panel>
    </Collapsible.Root>
  )
}

describeNative('Base UI Solid Collapsible', () => {
  it('opens and closes the panel on a click, and reports it', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onOpenChange={(open) => changes.push(open)} />)
    const trigger = query('button')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(app.renderer.findByText('Hidden text')).toBeUndefined()

    await click(app, trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(app.renderer.findByText('Hidden text')).toBeDefined()
    expect(changes).toEqual([true])

    await click(app, trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(app.renderer.findByText('Hidden text')).toBeUndefined()
    expect(changes).toEqual([true, false])
  })

  it('starts open with defaultOpen, and the trigger controls the panel', async () => {
    mount(() => <Example defaultOpen />)
    const trigger = query('button')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toBe('Hidden text')
    expect(exists('[data-panel-open]')).toBe(true)
  })

  it('toggles from the keyboard', async () => {
    const app = mount(() => <Example />)
    const trigger = query('button')
    await focus(app, trigger)
    await press(app, 'Enter')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await press(app, 'Space')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
