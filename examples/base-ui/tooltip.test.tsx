import { describe, expect, it } from 'vitest'
import { Tooltip } from '@base-ui/react/tooltip'
import { hasNativeTestRenderer } from '@ghia/react/testing'
import { box, byText, click, exists, focus, hover, hoverNothing, mount, press, query, settle, wait } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onOpenChange?: (open: boolean, details: { reason: string }) => void; delay?: number }) {
  return (
    <Tooltip.Provider delay={props.delay ?? 0} closeDelay={0}>
      <div style={{ position: 'absolute', top: 100, left: 150, width: 300, height: 200 }}>
        <Tooltip.Root onOpenChange={(open, details) => props.onOpenChange?.(open, details)}>
          <Tooltip.Trigger style={{ display: 'block', width: 90, height: 30 }}>Bold</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Positioner side="top" sideOffset={6}>
              <Tooltip.Popup data-testid="tip" style={{ display: 'block', width: 120, height: 24 }}>
                Make text bold
              </Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        </Tooltip.Root>
      </div>
    </Tooltip.Provider>
  )
}

function trigger(): HTMLElement {
  return byText('Bold', 'button')
}

describeNative('Base UI Tooltip', () => {
  it('is hidden until the pointer rests on the trigger, then shows its text above the trigger', async () => {
    const changes: Array<[boolean, string]> = []
    const app = mount(<Example onOpenChange={(open, details) => changes.push([open, details.reason])} />)
    expect(exists('[data-testid="tip"]')).toBe(false)

    await hover(app, trigger())
    await settle(app)
    const tip = query('[data-testid="tip"]')
    expect(tip.textContent).toBe('Make text bold')
    expect(changes).toEqual([[true, 'trigger-hover']])

    const anchor = box(trigger())
    const popup = box(tip)
    expect(popup.y + popup.height).toBeCloseTo(anchor.y - 6, 0)
    expect(popup.y).toBeGreaterThan(0)
  })

  it('hides when the pointer leaves the trigger', async () => {
    const changes: Array<[boolean, string]> = []
    const app = mount(<Example onOpenChange={(open, details) => changes.push([open, details.reason])} />)
    await hover(app, trigger())
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(true)

    await hoverNothing(app)
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(false)
    expect(changes[changes.length - 1]).toEqual([false, 'trigger-hover'])
  })

  it('waits for its delay before showing', async () => {
    const app = mount(<Example delay={300} />)
    await hover(app, trigger())
    await wait(app, 100)
    expect(exists('[data-testid="tip"]')).toBe(false)
    await wait(app, 400)
    expect(exists('[data-testid="tip"]')).toBe(true)
  })

  it('shows on keyboard focus, and hides on Escape', async () => {
    const changes: Array<[boolean, string]> = []
    const app = mount(<Example onOpenChange={(open, details) => changes.push([open, details.reason])} />)
    await focus(app, trigger())
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(true)
    await press(app, 'Escape')
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(false)
    expect(changes[changes.length - 1]).toEqual([false, 'escape-key'])
  })

  it('hides when the trigger is pressed', async () => {
    const app = mount(<Example />)
    await hover(app, trigger())
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(true)
    await click(app, trigger())
    await settle(app)
    expect(exists('[data-testid="tip"]')).toBe(false)
  })
})
