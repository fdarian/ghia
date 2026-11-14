import { describe, expect, it } from 'vitest'
import { Dialog } from '@photon-ai/base-ui-solid/dialog'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, box, byText, click, clickAt, exists, mount, press, query } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onOpenChange?: (open: boolean, reason: string | undefined) => void }) {
  return (
    <div style={{ display: 'block', width: '400px', height: '300px' }}>
      <Dialog.Root onOpenChange={(open, _event, reason) => props.onOpenChange?.(open, reason)}>
        <Dialog.Trigger style={{ display: 'block', width: '80px', height: '24px' }}>Open</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop
            data-testid="backdrop"
            style={{ position: 'fixed', top: '0px', left: '0px', width: '640px', height: '480px' }}
          />
          <Dialog.Popup
            data-testid="popup"
            style={{ position: 'fixed', top: '100px', left: '100px', width: '220px', height: '140px' }}
          >
            <Dialog.Title>Edit name</Dialog.Title>
            <Dialog.Description>Change how your name shows.</Dialog.Description>
            <input aria-label="Name" style={{ display: 'block', width: '160px', height: '24px' }} />
            <Dialog.Close style={{ display: 'block', width: '60px', height: '24px' }}>Done</Dialog.Close>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

describeNative('Base UI Solid Dialog', () => {
  it('is closed until its trigger is clicked, then shows a labelled dialog and reports the open state', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(() => <Example onOpenChange={(open, reason) => changes.push([open, reason])} />)
    const trigger = query('button')
    expect(exists('[role="dialog"]')).toBe(false)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    await click(app, trigger)
    const popup = query('[role="dialog"]')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(popup.getAttribute('aria-labelledby')).toBe(byText('Edit name').id)
    expect(popup.getAttribute('aria-describedby')).toBe(byText('Change how your name shows.').id)
    expect(changes).toEqual([[true, 'trigger-press']])
  })

  it('moves focus into the popup, keeps Tab inside it, and returns focus to the trigger on close', async () => {
    const app = mount(() => <Example />)
    const trigger = query('button')
    await click(app, trigger)
    expect(query('[role="dialog"]').contains(document.activeElement)).toBe(true)

    const visited: string[] = []
    for (let step = 0; step < 4; step++) {
      await press(app, 'Tab')
      expect(query('[role="dialog"]').contains(document.activeElement)).toBe(true)
      visited.push(activeText())
    }
    expect(new Set(visited).size).toBeGreaterThan(1)
    for (const text of visited) expect(text).not.toBe('Open')

    await press(app, 'Shift+Tab')
    expect(query('[role="dialog"]').contains(document.activeElement)).toBe(true)

    await press(app, 'Escape')
    expect(exists('[role="dialog"]')).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on Escape, reporting the reason', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(() => <Example onOpenChange={(open, reason) => changes.push([open, reason])} />)
    await click(app, query('button'))
    await press(app, 'Escape')
    expect(exists('[role="dialog"]')).toBe(false)
    expect(changes).toEqual([
      [true, 'trigger-press'],
      [false, 'escape-key'],
    ])
  })

  it('closes on a press on the backdrop, and not on one inside the popup', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(() => <Example onOpenChange={(open, reason) => changes.push([open, reason])} />)
    await click(app, query('button'))

    await click(app, byText('Edit name'))
    expect(exists('[role="dialog"]')).toBe(true)

    const popup = box(query('[data-testid="popup"]'))
    await clickAt(app, popup.x + popup.width + 40, popup.y + popup.height + 40)
    expect(exists('[role="dialog"]')).toBe(false)
    expect(changes[changes.length - 1]).toEqual([false, 'outside-press'])
  })

  it('closes from its close button and returns focus to the trigger', async () => {
    const app = mount(() => <Example />)
    const trigger = query('button')
    await click(app, trigger)
    await click(app, byText('Done'))
    expect(exists('[role="dialog"]')).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('places the popup where it is positioned, over the window, not at the origin', async () => {
    const app = mount(() => <Example />)
    await click(app, query('button'))
    const popup = box(query('[data-testid="popup"]'))
    expect(popup.x).toBe(100)
    expect(popup.y).toBe(100)
    expect(popup.width).toBe(220)
  })
})
