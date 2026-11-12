import { describe, expect, it } from 'vitest'
import { Popover } from '@base-ui/react/popover'
import { hasNativeTestRenderer } from '@ghia/react/testing'
import { activeText, box, byText, click, clickAt, exists, focus, mount, press, query, queryAll, settle } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Single(props: { onOpenChange?: (open: boolean, details: { reason: string }) => void }) {
  return (
    <div style={{ position: 'absolute', top: 100, left: 150, width: 300, height: 300 }}>
      <Popover.Root onOpenChange={(open, details) => props.onOpenChange?.(open, details)}>
        <Popover.Trigger style={{ display: 'block', width: 100, height: 30 }}>Open</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={8} data-testid="positioner">
            <Popover.Popup data-testid="popup" style={{ display: 'block', width: 180, height: 90 }}>
              <Popover.Title style={{ margin: 0 }}>Notes</Popover.Title>
              <input aria-label="Note" style={{ display: 'block', width: 120, height: 24 }} />
              <Popover.Close style={{ display: 'block', width: 60, height: 24 }}>Close</Popover.Close>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <p style={{ display: 'block', width: 100, height: 30, margin: 0, marginTop: 200 }}>Page text</p>
      <button type="button" style={{ display: 'block', width: 100, height: 30 }}>
        Elsewhere
      </button>
    </div>
  )
}

function trigger(): HTMLElement {
  return byText('Open', 'button')
}

describeNative('Base UI Popover', () => {
  it('opens on a trigger click, with the dialog role, expanded state and the reason reported', async () => {
    const changes: Array<[boolean, string]> = []
    const app = mount(<Single onOpenChange={(open, details) => changes.push([open, details.reason])} />)
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
    const app = mount(<Single />)
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
    const changes: Array<[boolean, string]> = []
    const app = mount(<Single onOpenChange={(open, details) => changes.push([open, details.reason])} />)
    await click(app, trigger())
    expect(query('[data-testid="popup"]').contains(document.activeElement)).toBe(true)

    await press(app, 'Escape')
    expect(exists('[data-testid="popup"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
    expect(changes[changes.length - 1]).toEqual([false, 'escape-key'])
  })

  it('closes on a press outside, and not on a press inside', async () => {
    const changes: Array<[boolean, string]> = []
    const app = mount(<Single onOpenChange={(open, details) => changes.push([open, details.reason])} />)
    await click(app, trigger())
    await click(app, byText('Notes'))
    expect(exists('[data-testid="popup"]')).toBe(true)

    await click(app, byText('Page text'))
    expect(exists('[data-testid="popup"]')).toBe(false)
    expect(changes[changes.length - 1]).toEqual([false, 'outside-press'])
  })

  it('closes when focus moves to another control, by a press on it or by Tab', async () => {
    const changes: Array<[boolean, string]> = []
    const app = mount(<Single onOpenChange={(open, details) => changes.push([open, details.reason])} />)
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
    const app = mount(<Single />)
    await click(app, trigger())
    await click(app, byText('Close', 'button'))
    expect(exists('[data-testid="popup"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
  })
})

type Panel = { label: string; rows: string[] }

const handle = Popover.createHandle<Panel>()

function Shared() {
  return (
    <div style={{ position: 'absolute', top: 60, left: 40, width: 500, height: 300 }}>
      <div style={{ display: 'flex', gap: 20, height: 30 }}>
        <Popover.Trigger handle={handle} payload={{ label: 'Alpha', rows: ['one', 'two'] }} style={{ display: 'block', width: 80, height: 30 }}>
          Alpha
        </Popover.Trigger>
        <Popover.Trigger handle={handle} payload={{ label: 'Beta', rows: ['three'] }} style={{ display: 'block', width: 80, height: 30 }}>
          Beta
        </Popover.Trigger>
      </div>
      <Popover.Root handle={handle}>
        {(root) => (
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="start" sideOffset={6}>
              <Popover.Popup data-testid="popup" style={{ display: 'block' }}>
                <Popover.Viewport data-testid="viewport">
                  {root.payload === undefined ? null : (
                    <div data-testid="panel">
                      <strong>{root.payload.label}</strong>
                      {root.payload.rows.map((row) => (
                        <p key={row}>{row}</p>
                      ))}
                    </div>
                  )}
                </Popover.Viewport>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </Popover.Root>
    </div>
  )
}

describeNative('Base UI Popover with several triggers sharing one popup', () => {
  it('shows the payload of the trigger that opened it, then swaps the content and moves to the other trigger', async () => {
    const app = mount(<Shared />)
    const alpha = byText('Alpha', 'button')
    const beta = byText('Beta', 'button')

    await click(app, alpha)
    await settle(app)
    expect(queryAll('[data-testid="popup"]').length).toBe(1)
    expect(app.renderer.findByText('one')).toBeDefined()
    expect(alpha.getAttribute('aria-expanded')).toBe('true')
    expect(beta.getAttribute('aria-expanded')).toBe('false')
    const first = box(query('[data-testid="popup"]'))
    expect(first.x).toBeCloseTo(box(alpha).x, 0)

    await click(app, beta)
    // The viewport swaps the content through a node it clones and appends (usePopupViewport).
    expect(query('[data-testid="viewport"]').getAttribute('data-activation-direction')).toContain('right')
    await settle(app)
    expect(queryAll('[data-testid="popup"]').length).toBe(1)
    expect(app.renderer.findByText('three')).toBeDefined()
    expect(app.renderer.findByText('one')).toBeUndefined()
    expect(beta.getAttribute('aria-expanded')).toBe('true')
    expect(alpha.getAttribute('aria-expanded')).toBe('false')
    const second = box(query('[data-testid="popup"]'))
    expect(second.x).toBeCloseTo(box(beta).x, 0)
    expect(second.x).toBeGreaterThan(first.x)
  })

  it('closes from the second trigger, and reopens for the first', async () => {
    const app = mount(<Shared />)
    const alpha = byText('Alpha', 'button')
    const beta = byText('Beta', 'button')
    await click(app, alpha)
    await click(app, beta)
    await click(app, beta)
    await settle(app)
    expect(exists('[data-testid="popup"]')).toBe(false)
    await click(app, alpha)
    await settle(app)
    expect(app.renderer.findByText('one')).toBeDefined()
    expect(activeText()).not.toBe('')
  })
})
