import { describe, expect, it } from 'vitest'
import { Dialog } from '@kobalte/core/dialog'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, byText, click, clickAt, exists, focus, mount, press, query } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onOpenChange?: (open: boolean) => void; modal?: boolean }) {
  return (
    <div style={{ position: 'absolute', top: 40, left: 40, width: 560, height: 400 }}>
      <Dialog onOpenChange={props.onOpenChange} modal={props.modal}>
        <Dialog.Trigger style={{ display: 'block', width: 100, height: 30 }}>Open</Dialog.Trigger>
        <Dialog.Portal>
          {props.modal !== false && (
            <Dialog.Overlay data-testid="overlay" style={{ position: 'fixed', top: 0, left: 0, width: 640, height: 480 }} />
          )}
          <div style={{ position: 'fixed', top: 100, left: 100, width: 300, height: 220 }}>
            <Dialog.Content data-testid="content" style={{ display: 'block', width: 300, height: 220 }}>
              <Dialog.Title style={{ margin: 0 }}>Profile</Dialog.Title>
              <Dialog.Description style={{ margin: 0 }}>Edit your profile</Dialog.Description>
              <input aria-label="Name" style={{ display: 'block', width: 150, height: 24 }} />
              <button type="button" style={{ display: 'block', width: 80, height: 24 }}>
                Save
              </button>
              <Dialog.CloseButton style={{ display: 'block', width: 80, height: 24 }}>Cancel</Dialog.CloseButton>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>
      <button type="button" style={{ display: 'block', width: 100, height: 30, marginTop: 340 }}>
        Elsewhere
      </button>
    </div>
  )
}

function trigger(): HTMLElement {
  return byText('Open', 'button')
}

describeNative('Kobalte Dialog', () => {
  it('opens on a trigger click, with the dialog role, its title and description wired, and the trigger expanded', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onOpenChange={(open) => changes.push(open)} />)
    expect(exists('[data-testid="content"]')).toBe(false)
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')

    await click(app, trigger())
    const content = query('[data-testid="content"]')
    expect(content.getAttribute('role')).toBe('dialog')
    expect(content.getAttribute('aria-labelledby')).toBe(byText('Profile').id)
    expect(content.getAttribute('aria-describedby')).toBe(byText('Edit your profile').id)
    expect(content.hasAttribute('data-expanded')).toBe(true)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(trigger().hasAttribute('data-expanded')).toBe(true)
    expect(changes).toEqual([true])
  })

  it('moves focus into the content on open, and back to the trigger on close from its close button', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    expect(query('[data-testid="content"]').contains(document.activeElement), activeText()).toBe(true)

    await click(app, byText('Cancel', 'button'))
    expect(exists('[data-testid="content"]')).toBe(false)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger())
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onOpenChange={(open) => changes.push(open)} />)
    await click(app, trigger())
    await press(app, 'Escape')
    expect(exists('[data-testid="content"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
    expect(changes).toEqual([true, false])
  })

  it('closes on a press outside the content, and stays open on a press inside', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await click(app, byText('Profile'))
    expect(exists('[data-testid="content"]')).toBe(true)

    await clickAt(app, 600, 450)
    expect(exists('[data-testid="content"]')).toBe(false)
  })

  it('traps Tab inside a modal dialog', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    const content = query('[data-testid="content"]')
    await focus(app, byText('Cancel', 'button'))
    await press(app, 'Tab')
    expect(content.contains(document.activeElement), activeText()).toBe(true)
    await press(app, 'Tab Tab Tab')
    expect(content.contains(document.activeElement), activeText()).toBe(true)
    await press(app, 'Shift+Tab')
    expect(content.contains(document.activeElement), activeText()).toBe(true)
  })

  it('hides the page behind a modal dialog from assistive technology, and shows it again on close', async () => {
    const app = mount(() => <Example />)
    const page = byText('Elsewhere', 'button')
    await click(app, trigger())
    expect(page.closest('[aria-hidden="true"]')).not.toBeNull()
    await press(app, 'Escape')
    expect(page.closest('[aria-hidden="true"]')).toBeNull()
  })

  it('a non-modal dialog leaves the page reachable: a press on it closes the dialog and takes focus', async () => {
    const app = mount(() => <Example modal={false} />)
    await click(app, trigger())
    expect(exists('[data-testid="content"]')).toBe(true)
    await click(app, byText('Elsewhere', 'button'))
    expect(exists('[data-testid="content"]')).toBe(false)
    expect(document.activeElement).toBe(byText('Elsewhere', 'button'))
  })
})
