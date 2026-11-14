import { describe, expect, it } from 'vitest'
import { Popover } from '@photon-ai/base-ui-solid/popover'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, box, byText, click, clickAt, exists, focus, mount, press, query, queryAll, settle } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Single(props: { onOpenChange?: (open: boolean, reason: string | undefined) => void }) {
  return (
    <div style={{ position: 'absolute', top: '100px', left: '150px', width: '300px', height: '300px' }}>
      <Popover.Root onOpenChange={(open, _event, reason) => props.onOpenChange?.(open, reason)}>
        <Popover.Trigger style={{ display: 'block', width: '100px', height: '30px' }}>Open</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={8} data-testid="positioner">
            <Popover.Popup data-testid="popup" style={{ display: 'block', width: '180px', height: '90px' }}>
              <Popover.Title style={{ margin: '0px' }}>Notes</Popover.Title>
              <input aria-label="Note" style={{ display: 'block', width: '120px', height: '24px' }} />
              <Popover.Close style={{ display: 'block', width: '60px', height: '24px' }}>Close</Popover.Close>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <p style={{ display: 'block', width: '100px', height: '30px', margin: '0px', marginTop: '200px' }}>Page text</p>
      <button type="button" style={{ display: 'block', width: '100px', height: '30px' }}>
        Elsewhere
      </button>
    </div>
  )
}

function trigger(): HTMLElement {
  return byText('Open', 'button')
}

describeNative('Base UI Solid Popover', () => {
  it('opens on a trigger click, with the dialog role, expanded state and the reason reported', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(() => <Single onOpenChange={(open, reason) => changes.push([open, reason])} />)
    expect(exists('[data-testid="popup"]')).toBe(false)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')

    await click(app, trigger())
    const popup = query('[data-testid="popup"]')
    expect(popup.getAttribute('role')).toBe('dialog')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(popup.getAttribute('aria-labelledby')).toBe(byText('Notes').id)
    expect(changes).toEqual([[true, 'trigger-press']])
  })

  it('places the popup next to its trigger, not at the origin', async () => {
    const app = mount(() => <Single />)
    await click(app, trigger())
    await settle(app)
    const anchor = box(trigger())
    const popup = box(query('[data-testid="popup"]'))
    expect(popup.y).toBeCloseTo(anchor.y + anchor.height + 8, 0)
    expect(popup.x).toBeCloseTo(anchor.x, 0)
    expect(popup.width).toBe(180)
    expect(popup.x).toBeGreaterThan(0)
    expect(popup.y).toBeGreaterThan(0)
  })

  it('moves focus into the popup, and returns it to the trigger on Escape', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(() => <Single onOpenChange={(open, reason) => changes.push([open, reason])} />)
    await click(app, trigger())
    expect(query('[data-testid="popup"]').contains(document.activeElement)).toBe(true)

    await press(app, 'Escape')
    expect(exists('[data-testid="popup"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
    expect(changes[changes.length - 1]).toEqual([false, 'escape-key'])
  })

  it('closes on a press outside, and not on a press inside', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(() => <Single onOpenChange={(open, reason) => changes.push([open, reason])} />)
    await click(app, trigger())
    await click(app, byText('Notes'))
    expect(exists('[data-testid="popup"]')).toBe(true)

    await click(app, byText('Page text'))
    expect(exists('[data-testid="popup"]')).toBe(false)
    expect(changes[changes.length - 1]).toEqual([false, 'outside-press'])
  })

  it('closes when focus moves to another control, by a press on it or by Tab', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(() => <Single onOpenChange={(open, reason) => changes.push([open, reason])} />)
    await click(app, trigger())
    await click(app, byText('Elsewhere', 'button'))
    expect(exists('[data-testid="popup"]')).toBe(false)
    expect(document.activeElement).toBe(byText('Elsewhere', 'button'))
    expect(changes[changes.length - 1]).toEqual([false, 'focus-out'])

    await click(app, trigger())
    await focus(app, byText('Close', 'button'))
    await press(app, 'Tab')
    expect(exists('[data-testid="popup"]')).toBe(false)
    expect(changes[changes.length - 1]).toEqual([false, 'focus-out'])
  })

  it('closes from its close button and returns focus to the trigger', async () => {
    const app = mount(() => <Single />)
    await click(app, trigger())
    await click(app, byText('Close', 'button'))
    expect(exists('[data-testid="popup"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
  })
})
