import { describe, expect, it } from 'vitest'
import { Menu } from '@photon-ai/base-ui-solid/menu'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, box, byText, click, exists, focus, mount, press, query, queryAll, settle } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Single(props: { onAction?: (name: string) => void; onOpenChange?: (open: boolean, reason: string | undefined) => void }) {
  const item = { display: 'block', width: '140px', height: '24px' } as const
  return (
    <div style={{ position: 'absolute', top: '80px', left: '120px', width: '300px', height: '300px' }}>
      <Menu.Root onOpenChange={(open, _event, reason) => props.onOpenChange?.(open, reason)}>
        <Menu.Trigger style={{ display: 'block', width: '100px', height: '30px' }}>Actions</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={4}>
            <Menu.Popup data-testid="popup" style={{ display: 'block', width: '150px' }}>
              <Menu.Item style={item} onClick={() => props.onAction?.('cut')}>Cut</Menu.Item>
              <Menu.Item style={item} onClick={() => props.onAction?.('copy')}>Copy</Menu.Item>
              <Menu.Item style={item} disabled onClick={() => props.onAction?.('paste')}>Paste</Menu.Item>
              <Menu.Item style={item} onClick={() => props.onAction?.('delete')}>Delete</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <p style={{ display: 'block', width: '100px', height: '30px', margin: '0px', marginTop: '200px' }}>Page text</p>
    </div>
  )
}

function trigger(): HTMLElement {
  return byText('Actions', 'button')
}

describeNative('Base UI Solid Menu', () => {
  it('opens on a click with the menu and menuitem roles, placed under the trigger', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(() => <Single onOpenChange={(open, reason) => changes.push([open, reason])} />)
    expect(exists('[role="menu"]')).toBe(false)
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')

    await click(app, trigger())
    await settle(app)
    expect(query('[role="menu"]')).toBe(query('[data-testid="popup"]'))
    expect(queryAll('[role="menuitem"]').map((item) => item.textContent)).toEqual(['Cut', 'Copy', 'Paste', 'Delete'])
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(changes).toEqual([[true, 'trigger-press']])

    const anchor = box(trigger())
    const popup = box(query('[data-testid="popup"]'))
    expect(popup.y).toBeCloseTo(anchor.y + anchor.height + 4, 0)
    expect(popup.x).toBeCloseTo(anchor.x, 0)
  })

  it('moves focus with the arrow keys and wraps, and a disabled item takes focus but not a press', async () => {
    const app = mount(() => <Single />)
    await click(app, trigger())
    await settle(app)
    await press(app, 'ArrowDown')
    expect(activeText()).toBe('Cut')
    await press(app, 'ArrowDown')
    expect(activeText()).toBe('Copy')
    await press(app, 'ArrowDown')
    expect(activeText()).toBe('Paste')
    expect(document.activeElement.getAttribute('aria-disabled')).toBe('true')
    await press(app, 'ArrowDown')
    expect(activeText()).toBe('Delete')
    await press(app, 'ArrowDown')
    expect(activeText()).toBe('Cut')
    await press(app, 'ArrowUp')
    expect(activeText()).toBe('Delete')
    await press(app, 'Home')
    expect(activeText()).toBe('Cut')
    await press(app, 'End')
    expect(activeText()).toBe('Delete')
  })

  it('leaves data-highlighted on only the item that holds the highlight', async () => {
    const app = mount(() => <Single />)
    await click(app, trigger())
    await settle(app)
    await press(app, 'ArrowDown')
    await press(app, 'ArrowDown')
    expect(queryAll('[role="menuitem"][data-highlighted]').map((item) => item.textContent)).toEqual(['Copy'])
  })

  it('opens from the keyboard on the trigger with ArrowDown', async () => {
    const app = mount(() => <Single />)
    await focus(app, trigger())
    await press(app, 'ArrowDown')
    expect(exists('[role="menu"]')).toBe(true)
    expect(query('[role="menu"]').contains(document.activeElement)).toBe(true)
    await press(app, 'Escape')
    expect(exists('[role="menu"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
  })

  it('runs an item on Enter and closes, returning focus to the trigger', async () => {
    const actions: string[] = []
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(
      () => <Single onAction={(name) => actions.push(name)} onOpenChange={(open, reason) => changes.push([open, reason])} />,
    )
    await click(app, trigger())
    await settle(app)
    await press(app, 'ArrowDown')
    await press(app, 'ArrowDown')
    await press(app, 'Enter')
    expect(actions).toEqual(['copy'])
    expect(exists('[role="menu"]')).toBe(false)
    expect(changes[changes.length - 1]).toEqual([false, 'item-press'])
    expect(document.activeElement).toBe(trigger())
  })

  it('runs an item on a click, and ignores a disabled one', async () => {
    const actions: string[] = []
    const app = mount(() => <Single onAction={(name) => actions.push(name)} />)
    await click(app, trigger())
    await settle(app)
    await click(app, byText('Paste', '[role="menuitem"]'))
    expect(actions).toEqual([])
    expect(exists('[role="menu"]')).toBe(true)
    await click(app, byText('Delete', '[role="menuitem"]'))
    expect(actions).toEqual(['delete'])
    expect(exists('[role="menu"]')).toBe(false)
  })

  it('highlights the item whose name is typed', async () => {
    const app = mount(() => <Single />)
    await click(app, trigger())
    await settle(app)
    await press(app, 'd')
    expect(queryAll('[role="menuitem"][data-highlighted]').map((item) => item.textContent)).toEqual(['Delete'])
  })

  it('closes on a press outside', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const app = mount(() => <Single onOpenChange={(open, reason) => changes.push([open, reason])} />)
    await click(app, trigger())
    await settle(app)
    await click(app, byText('Page text'))
    expect(exists('[role="menu"]')).toBe(false)
    expect(changes[changes.length - 1]).toEqual([false, 'outside-press'])
  })
})
