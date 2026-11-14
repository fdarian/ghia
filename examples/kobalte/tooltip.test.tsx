import { describe, expect, it } from 'vitest'
import { Tooltip } from '@kobalte/core/tooltip'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { box, byText, click, exists, focus, hover, hoverNothing, mount, press, query, settle, wait } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onOpenChange?: (open: boolean) => void; openDelay?: number }) {
  return (
    <div style={{ position: 'absolute', top: 100, left: 150, width: 300, height: 200 }}>
      <Tooltip openDelay={props.openDelay ?? 0} closeDelay={0} placement="top" gutter={6} onOpenChange={props.onOpenChange}>
        <Tooltip.Trigger style={{ display: 'block', width: 90, height: 30 }}>Bold</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content data-testid="tip" style={{ display: 'block', width: 120, height: 24 }}>
            Make text bold
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip>
      <button type="button" style={{ display: 'block', width: 90, height: 30, marginTop: 100 }}>
        Other
      </button>
    </div>
  )
}

function trigger(): HTMLElement {
  return byText('Bold', 'button')
}

describeNative('Kobalte Tooltip', () => {
  it('is hidden until the pointer rests on the trigger, then shows its text above the trigger with the tooltip role', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onOpenChange={(open) => changes.push(open)} />)
    expect(exists('[data-testid="tip"]')).toBe(false)

    await hover(app, trigger())
    await settle(app)
    const tip = query('[data-testid="tip"]')
    expect(tip.textContent).toBe('Make text bold')
    expect(tip.getAttribute('role')).toBe('tooltip')
    expect(trigger().getAttribute('aria-describedby')).toBe(tip.id)
    expect(tip.hasAttribute('data-expanded')).toBe(true)
    expect(changes).toEqual([true])

    const anchor = box(trigger())
    const popup = box(tip)
    expect(popup.y + popup.height).toBeCloseTo(anchor.y - 6, 0)
    expect(popup.y).toBeGreaterThan(0)
  })

  it('does not show before the open delay has passed', async () => {
    const app = mount(() => <Example openDelay={400} />)
    await hover(app, trigger())
    await wait(app, 150)
    expect(exists('[data-testid="tip"]')).toBe(false)
    await wait(app, 450)
    expect(exists('[data-testid="tip"]')).toBe(true)
  })

  it('hides when the pointer leaves the trigger', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onOpenChange={(open) => changes.push(open)} />)
    await hover(app, trigger())
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(true)

    await hoverNothing(app)
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it('shows on keyboard focus of the trigger, and hides on Escape', async () => {
    const app = mount(() => <Example />)
    await press(app, 'Tab')
    expect(document.activeElement).toBe(trigger())
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(true)

    await press(app, 'Escape')
    expect(exists('[data-testid="tip"]')).toBe(false)
  })

  it('hides when the trigger is pressed', async () => {
    const app = mount(() => <Example />)
    await hover(app, trigger())
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(true)
    await click(app, trigger())
    expect(exists('[data-testid="tip"]')).toBe(false)
  })

  it('hides when focus moves away from the trigger', async () => {
    const app = mount(() => <Example />)
    await focus(app, trigger())
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(true)
    await focus(app, byText('Other', 'button'))
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(false)
  })
})
