import { describe, expect, it } from 'vitest'
import { Menu } from '@base-ui/react/menu'
import { hasNativeTestRenderer } from '@ghia/react/testing'
import { activeText, box, byText, click, exists, focus, mount, press, query, queryAll, settle } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Single(props: { onAction?: (name: string) => void; onOpenChange?: (open: boolean, details: { reason: string }) => void }) {
  const item = { display: 'block', width: 140, height: 24 } as const
  return (
    <div style={{ position: 'absolute', top: 80, left: 120, width: 300, height: 300 }}>
      <Menu.Root onOpenChange={(open, details) => props.onOpenChange?.(open, details)}>
        <Menu.Trigger style={{ display: 'block', width: 100, height: 30 }}>Actions</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={4}>
            <Menu.Popup data-testid="popup" style={{ display: 'block', width: 150 }}>
              <Menu.Item style={item} onClick={() => props.onAction?.('cut')}>Cut</Menu.Item>
              <Menu.Item style={item} onClick={() => props.onAction?.('copy')}>Copy</Menu.Item>
              <Menu.Item style={item} disabled onClick={() => props.onAction?.('paste')}>Paste</Menu.Item>
              <Menu.Item style={item} onClick={() => props.onAction?.('delete')}>Delete</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <p style={{ display: 'block', width: 100, height: 30, margin: 0, marginTop: 200 }}>Page text</p>
    </div>
  )
}

function trigger(): HTMLElement {
  return byText('Actions', 'button')
}

describeNative('Base UI Menu', () => {
  it('opens on a click with the menu and menuitem roles, placed under the trigger', async () => {
    const changes: Array<[boolean, string]> = []
    const app = mount(<Single onOpenChange={(open, details) => changes.push([open, details.reason])} />)
    expect(exists('[role="menu"]')).toBe(false)
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')

    await click(app, trigger())
    await settle(app, 60)
    expect(query('[role="menu"]')).toBe(query('[data-testid="popup"]'))
    expect(queryAll('[role="menuitem"]').map((item) => item.textContent)).toEqual(['Cut', 'Copy', 'Paste', 'Delete'])
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(changes).toEqual([[true, 'trigger-press']])

    const anchor = box(trigger())
    const popup = box(query('[data-testid="popup"]'))
    expect(popup.y).toBeCloseTo(anchor.y + anchor.height + 4, 0)
    expect(popup.x).toBeCloseTo(anchor.x, 0)
  })

  it('moves the highlight with the arrow keys and wraps, and a disabled item takes the highlight but not a press', async () => {
    const app = mount(<Single />)
    await click(app, trigger())
    await settle(app, 60)
    const highlighted = () => queryAll('[role="menuitem"][data-highlighted]').map((item) => item.textContent)

    await press(app, 'ArrowDown')
    expect(highlighted()).toEqual(['Cut'])
    expect(activeText()).toBe('Cut')
    await press(app, 'ArrowDown')
    expect(highlighted()).toEqual(['Copy'])
    await press(app, 'ArrowDown')
    expect(highlighted()).toEqual(['Paste'])
    expect(query('[role="menuitem"][data-highlighted]').getAttribute('aria-disabled')).toBe('true')
    await press(app, 'ArrowDown')
    expect(highlighted()).toEqual(['Delete'])
    await press(app, 'ArrowDown')
    expect(highlighted()).toEqual(['Cut'])
    await press(app, 'ArrowUp')
    expect(highlighted()).toEqual(['Delete'])
    await press(app, 'Home')
    expect(highlighted()).toEqual(['Cut'])
    await press(app, 'End')
    expect(highlighted()).toEqual(['Delete'])
  })

  it('opens from the keyboard on the trigger with ArrowDown', async () => {
    const app = mount(<Single />)
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
    const changes: Array<[boolean, string]> = []
    const app = mount(
      <Single onAction={(name) => actions.push(name)} onOpenChange={(open, details) => changes.push([open, details.reason])} />,
    )
    await click(app, trigger())
    await settle(app, 60)
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
    const app = mount(<Single onAction={(name) => actions.push(name)} />)
    await click(app, trigger())
    await settle(app, 60)
    await click(app, byText('Paste', '[role="menuitem"]'))
    expect(actions).toEqual([])
    expect(exists('[role="menu"]')).toBe(true)
    await click(app, byText('Delete', '[role="menuitem"]'))
    expect(actions).toEqual(['delete'])
    expect(exists('[role="menu"]')).toBe(false)
  })

  it('highlights the item whose name is typed', async () => {
    const app = mount(<Single />)
    await click(app, trigger())
    await settle(app, 60)
    await press(app, 'd')
    expect(queryAll('[role="menuitem"][data-highlighted]').map((item) => item.textContent)).toEqual(['Delete'])
  })

  it('closes on a press outside', async () => {
    const changes: Array<[boolean, string]> = []
    const app = mount(<Single onOpenChange={(open, details) => changes.push([open, details.reason])} />)
    await click(app, trigger())
    await settle(app, 60)
    await click(app, byText('Page text'))
    expect(exists('[role="menu"]')).toBe(false)
    expect(changes[changes.length - 1]).toEqual([false, 'outside-press'])
  })
})

type Items = { label: string; items: string[] }

const handle = Menu.createHandle<Items>()

function Shared(props: { onAction?: (name: string) => void }) {
  return (
    <div style={{ position: 'absolute', top: 60, left: 40, width: 500, height: 300 }}>
      <div style={{ display: 'flex', gap: 20, height: 30 }}>
        <Menu.Trigger handle={handle} payload={{ label: 'File', items: ['New', 'Open'] }} style={{ display: 'block', width: 70, height: 30 }}>
          File
        </Menu.Trigger>
        <Menu.Trigger handle={handle} payload={{ label: 'Edit', items: ['Undo', 'Redo', 'Cut'] }} style={{ display: 'block', width: 70, height: 30 }}>
          Edit
        </Menu.Trigger>
      </div>
      <Menu.Root handle={handle} modal={false}>
        {(root) => (
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="start" sideOffset={4}>
              <Menu.Popup data-testid="popup" style={{ display: 'block', width: 120 }}>
                <Menu.Viewport>
                  {(root.payload?.items ?? []).map((name) => (
                    <Menu.Item key={name} style={{ display: 'block', width: 110, height: 24 }} onClick={() => props.onAction?.(name)}>
                      {name}
                    </Menu.Item>
                  ))}
                </Menu.Viewport>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        )}
      </Menu.Root>
    </div>
  )
}

describeNative('Base UI Menu with several triggers sharing one popup', () => {
  it('closes a modal menu on a press on another trigger, which then opens its own items', async () => {
    const app = mount(
      <div style={{ position: 'absolute', top: 60, left: 40, width: 500, height: 300 }}>
        <div style={{ display: 'flex', gap: 20, height: 30 }}>
          <Menu.Trigger handle={handle} payload={{ label: 'File', items: ['New'] }} style={{ display: 'block', width: 70, height: 30 }}>
            File
          </Menu.Trigger>
          <Menu.Trigger handle={handle} payload={{ label: 'Edit', items: ['Undo'] }} style={{ display: 'block', width: 70, height: 30 }}>
            Edit
          </Menu.Trigger>
        </div>
        <Menu.Root handle={handle}>
          {(root) => (
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="start" sideOffset={4}>
                <Menu.Popup data-testid="popup" style={{ display: 'block', width: 120 }}>
                  {(root.payload?.items ?? []).map((name) => (
                    <Menu.Item key={name} style={{ display: 'block', width: 110, height: 24 }}>
                      {name}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          )}
        </Menu.Root>
      </div>,
    )
    await click(app, byText('File', 'button'))
    await settle(app, 60)
    expect(queryAll('[role="menuitem"]').map((item) => item.textContent)).toEqual(['New'])
    await click(app, byText('Edit', 'button'))
    await settle(app, 100)
    expect(exists('[role="menu"]')).toBe(false)
    await click(app, byText('Edit', 'button'))
    await settle(app, 60)
    expect(queryAll('[role="menuitem"]').map((item) => item.textContent)).toEqual(['Undo'])
  })

  it('lists the items of the trigger that opened it, then swaps them and moves under the other trigger', async () => {
    const actions: string[] = []
    const app = mount(<Shared onAction={(name) => actions.push(name)} />)
    const file = byText('File', 'button')
    const edit = byText('Edit', 'button')

    await click(app, file)
    await settle(app, 60)
    expect(queryAll('[role="menuitem"]').map((item) => item.textContent)).toEqual(['New', 'Open'])
    expect(file.getAttribute('aria-expanded')).toBe('true')
    const first = box(query('[data-testid="popup"]'))
    expect(first.x).toBeCloseTo(box(file).x, 0)

    await click(app, edit)
    await settle(app, 400)
    expect(queryAll('[data-testid="popup"]').length).toBe(1)
    expect(queryAll('[role="menuitem"]').map((item) => item.textContent)).toEqual(['Undo', 'Redo', 'Cut'])
    expect(edit.getAttribute('aria-expanded')).toBe('true')
    expect(file.getAttribute('aria-expanded')).toBe('false')
    const second = box(query('[data-testid="popup"]'))
    expect(second.x).toBeCloseTo(box(edit).x, 0)
    expect(second.x).toBeGreaterThan(first.x)

    await click(app, byText('Redo', '[role="menuitem"]'))
    expect(actions).toEqual(['Redo'])
    expect(exists('[role="menu"]')).toBe(false)
  })
})
