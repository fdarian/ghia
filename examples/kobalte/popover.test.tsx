import { describe, expect, it } from 'vitest'
import { Popover } from '@kobalte/core/popover'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, box, byText, click, exists, focus, mount, press, query } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onOpenChange?: (open: boolean) => void }) {
  return (
    <div style={{ position: 'absolute', top: 100, left: 150, width: 300, height: 300 }}>
      <Popover onOpenChange={props.onOpenChange} placement="bottom-start" gutter={8}>
        <Popover.Trigger style={{ display: 'block', width: 100, height: 30 }}>Open</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content data-testid="content" style={{ display: 'block', width: 180, height: 90 }}>
            <Popover.Title style={{ margin: 0 }}>Notes</Popover.Title>
            <Popover.Description style={{ margin: 0 }}>Short notes</Popover.Description>
            <input aria-label="Note" style={{ display: 'block', width: 120, height: 24 }} />
            <Popover.CloseButton style={{ display: 'block', width: 60, height: 24 }}>Close</Popover.CloseButton>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
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

describeNative('Kobalte Popover', () => {
  it('opens on a trigger click, with the dialog role, expanded state and its title and description wired', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onOpenChange={(open) => changes.push(open)} />)
    expect(exists('[data-testid="content"]')).toBe(false)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')

    await click(app, trigger())
    const content = query('[data-testid="content"]')
    expect(content.getAttribute('role')).toBe('dialog')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(trigger().getAttribute('aria-controls')).toBe(content.id)
    expect(content.getAttribute('aria-labelledby')).toBe(byText('Notes').id)
    expect(content.getAttribute('aria-describedby')).toBe(byText('Short notes').id)
    expect(changes).toEqual([true])
  })

  it('places the content next to its trigger, not at the origin', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    const anchor = box(trigger())
    const content = box(query('[data-testid="content"]'))
    expect(content.y).toBeCloseTo(anchor.y + anchor.height + 8, 0)
    expect(content.x).toBeCloseTo(anchor.x, 0)
    expect(content.width).toBe(180)
  })

  it('moves focus into the content, and returns it to the trigger on Escape', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onOpenChange={(open) => changes.push(open)} />)
    await click(app, trigger())
    expect(query('[data-testid="content"]').contains(document.activeElement), activeText()).toBe(true)

    await press(app, 'Escape')
    expect(exists('[data-testid="content"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
    expect(changes).toEqual([true, false])
  })

  it('closes on a press outside, and not on a press inside', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await click(app, byText('Notes'))
    expect(exists('[data-testid="content"]')).toBe(true)

    await click(app, byText('Page text'))
    expect(exists('[data-testid="content"]')).toBe(false)
  })

  it('closes when the trigger is pressed again', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    expect(exists('[data-testid="content"]')).toBe(true)
    await click(app, trigger())
    expect(exists('[data-testid="content"]')).toBe(false)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes when focus leaves the content, by a press on another control', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await click(app, byText('Elsewhere', 'button'))
    expect(exists('[data-testid="content"]')).toBe(false)
    expect(document.activeElement).toBe(byText('Elsewhere', 'button'))
  })

  it('closes from its close button and returns focus to the trigger', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await click(app, byText('Close', 'button'))
    expect(exists('[data-testid="content"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
  })

  it('opens from the keyboard with Enter on the focused trigger', async () => {
    const app = mount(() => <Example />)
    await focus(app, trigger())
    await press(app, 'Enter')
    expect(exists('[data-testid="content"]')).toBe(true)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })
})
