import { describe, expect, it } from 'vitest'
import { AlertDialog } from '@photon-ai/base-ui-solid/alert-dialog'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { box, byText, click, clickAt, exists, mount, press, query } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onOpenChange?: (open: boolean, reason: string | undefined) => void }) {
  return (
    <div style={{ display: 'block', width: '400px', height: '300px' }}>
      <AlertDialog.Root onOpenChange={(open, _event, reason) => props.onOpenChange?.(open, reason)}>
        <AlertDialog.Trigger style={{ display: 'block', width: '80px', height: '24px' }}>Delete</AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop
            style={{ position: 'fixed', top: '0px', left: '0px', width: '640px', height: '480px' }}
          />
          <AlertDialog.Popup
            data-testid="popup"
            style={{ position: 'fixed', top: '100px', left: '100px', width: '220px', height: '120px' }}
          >
            <AlertDialog.Title>Delete this?</AlertDialog.Title>
            <AlertDialog.Description>It cannot be undone.</AlertDialog.Description>
            <AlertDialog.Close style={{ display: 'block', width: '60px', height: '24px' }}>Cancel</AlertDialog.Close>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

describeNative('Base UI Solid AlertDialog', () => {
  it('opens as an alertdialog labelled by its title, with focus inside, and closes on Escape back to the trigger', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(() => <Example onOpenChange={(open, reason) => changes.push([open, reason])} />)
    const trigger = query('button')
    expect(exists('[role="alertdialog"]')).toBe(false)

    await click(app, trigger)
    const popup = query('[role="alertdialog"]')
    expect(popup.getAttribute('aria-labelledby')).toBe(byText('Delete this?').id)
    expect(popup.getAttribute('aria-describedby')).toBe(byText('It cannot be undone.').id)
    expect(popup.contains(document.activeElement)).toBe(true)

    await press(app, 'Escape')
    expect(exists('[role="alertdialog"]')).toBe(false)
    expect(document.activeElement).toBe(trigger)
    expect(changes).toEqual([
      [true, 'trigger-press'],
      [false, 'escape-key'],
    ])
  })

  it('stays open on a press outside the popup, and closes from its close button', async () => {
    const app = mount(() => <Example />)
    const trigger = query('button')
    await click(app, trigger)
    const popup = box(query('[data-testid="popup"]'))
    await clickAt(app, popup.x + popup.width + 40, popup.y + popup.height + 40)
    expect(exists('[role="alertdialog"]')).toBe(true)

    await click(app, byText('Cancel'))
    expect(exists('[role="alertdialog"]')).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })
})
