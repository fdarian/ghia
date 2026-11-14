import { createSignal } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { DropdownMenu } from '@kobalte/core/dropdown-menu'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, box, byText, click, exists, focus, mount, press, query, queryAll, settle } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const ITEM = { display: 'block', width: 150, height: 24 } as const

function Example(props: { onSelect?: (name: string) => void; onOpenChange?: (open: boolean) => void }) {
  const [bookmarked, setBookmarked] = createSignal(false)
  const [theme, setTheme] = createSignal('light')
  return (
    <div style={{ position: 'absolute', top: 60, left: 100, width: 400, height: 380 }}>
      <DropdownMenu onOpenChange={props.onOpenChange} gutter={6}>
        <DropdownMenu.Trigger style={{ display: 'block', width: 100, height: 30 }}>Actions</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content data-testid="menu" style={{ display: 'block', width: 160 }}>
            <DropdownMenu.Item style={ITEM} onSelect={() => props.onSelect?.('copy')}>
              Copy
            </DropdownMenu.Item>
            <DropdownMenu.Item style={ITEM} disabled onSelect={() => props.onSelect?.('paste')}>
              Paste
            </DropdownMenu.Item>
            <DropdownMenu.Item style={ITEM} onSelect={() => props.onSelect?.('delete')}>
              Delete
            </DropdownMenu.Item>
            <DropdownMenu.Separator style={{ display: 'block', width: 150, height: 1 }} />
            <DropdownMenu.CheckboxItem style={ITEM} checked={bookmarked()} onChange={setBookmarked}>
              Bookmark
            </DropdownMenu.CheckboxItem>
            <DropdownMenu.RadioGroup value={theme()} onChange={setTheme}>
              <DropdownMenu.RadioItem style={ITEM} value="light">
                Light
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem style={ITEM} value="dark">
                Dark
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
      <p style={{ display: 'block', width: 100, height: 30, margin: 0, marginTop: 280 }}>Page text</p>
    </div>
  )
}

function trigger(): HTMLElement {
  return byText('Actions', 'button')
}

function item(label: string): HTMLElement {
  return byText(label, '[role^="menuitem"]')
}

function menuLabels(): string[] {
  return queryAll('[role^="menuitem"]').map((element) => element.textContent ?? '')
}

describeNative('Kobalte DropdownMenu', () => {
  it('is closed at first, a menu button with aria-haspopup', () => {
    mount(() => <Example />)
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(exists('[role="menu"]')).toBe(false)
  })

  it('opens on a click with the items, the right roles, and the menu under the trigger', async () => {
    const opens: boolean[] = []
    const app = mount(() => <Example onOpenChange={(open) => opens.push(open)} />)
    await click(app, trigger())
    await settle(app)
    const menu = query('[role="menu"]')
    expect(menuLabels()).toEqual(['Copy', 'Paste', 'Delete', 'Bookmark', 'Light', 'Dark'])
    expect(item('Bookmark').getAttribute('role')).toBe('menuitemcheckbox')
    expect(item('Light').getAttribute('role')).toBe('menuitemradio')
    expect(item('Paste').getAttribute('aria-disabled')).toBe('true')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(opens).toEqual([true])
    expect(menu.contains(document.activeElement), activeText()).toBe(true)

    const anchor = box(trigger())
    const content = box(query('[data-testid="menu"]'))
    expect(content.y).toBeCloseTo(anchor.y + anchor.height + 6, 0)
  })

  it('opens from the keyboard with Enter and focuses the first item; ArrowDown skips the disabled one', async () => {
    const app = mount(() => <Example />)
    await focus(app, trigger())
    await press(app, 'Enter')
    await settle(app)
    expect(exists('[role="menu"]')).toBe(true)
    expect(document.activeElement, activeText()).toBe(item('Copy'))
    await press(app, 'ArrowDown')
    expect(document.activeElement, activeText()).toBe(item('Delete'))
    await press(app, 'ArrowDown')
    expect(document.activeElement, activeText()).toBe(item('Bookmark'))
    await press(app, 'ArrowUp ArrowUp')
    expect(document.activeElement, activeText()).toBe(item('Copy'))
    await press(app, 'End')
    expect(document.activeElement, activeText()).toBe(item('Dark'))
    await press(app, 'Home')
    expect(document.activeElement, activeText()).toBe(item('Copy'))
  })

  it('opens with ArrowDown on the focused trigger and with ArrowUp on the last item', async () => {
    const app = mount(() => <Example />)
    await focus(app, trigger())
    await press(app, 'ArrowDown')
    await settle(app)
    expect(document.activeElement, activeText()).toBe(item('Copy'))
    await press(app, 'Escape')
    await settle(app)
    expect(document.activeElement).toBe(trigger())
    await press(app, 'ArrowUp')
    await settle(app)
    expect(document.activeElement, activeText()).toBe(item('Dark'))
  })

  it('selects an item on a click: onSelect runs, the menu closes, focus returns to the trigger', async () => {
    const selected: string[] = []
    const app = mount(() => <Example onSelect={(name) => selected.push(name)} />)
    await click(app, trigger())
    await settle(app)
    await click(app, item('Delete'))
    await settle(app)
    expect(selected).toEqual(['delete'])
    expect(exists('[role="menu"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
  })

  it('selects the focused item with Enter and with Space', async () => {
    const selected: string[] = []
    const app = mount(() => <Example onSelect={(name) => selected.push(name)} />)
    await focus(app, trigger())
    await press(app, 'Enter')
    await settle(app)
    await press(app, 'Enter')
    await settle(app)
    expect(selected).toEqual(['copy'])
    expect(exists('[role="menu"]')).toBe(false)

    await press(app, 'Enter')
    await settle(app)
    await press(app, 'ArrowDown Space')
    await settle(app)
    expect(selected).toEqual(['copy', 'delete'])
  })

  it('does not select a disabled item', async () => {
    const selected: string[] = []
    const app = mount(() => <Example onSelect={(name) => selected.push(name)} />)
    await click(app, trigger())
    await settle(app)
    await click(app, item('Paste'))
    await settle(app)
    expect(selected).toEqual([])
    expect(exists('[role="menu"]')).toBe(true)
  })

  it('jumps to the item that starts with the typed letters', async () => {
    const app = mount(() => <Example />)
    await focus(app, trigger())
    await press(app, 'Enter')
    await settle(app)
    await press(app, 'd')
    expect(document.activeElement, activeText()).toBe(item('Delete'))
    await press(app, 'b')
    expect(document.activeElement, activeText()).toBe(item('Bookmark'))
  })

  it('toggles a checkbox item and a radio group, with aria-checked following, and closes on select', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await settle(app)
    expect(item('Bookmark').getAttribute('aria-checked')).toBe('false')
    expect(item('Light').getAttribute('aria-checked')).toBe('true')
    expect(item('Dark').getAttribute('aria-checked')).toBe('false')

    await click(app, item('Bookmark'))
    await settle(app)
    expect(exists('[role="menu"]')).toBe(false)
    await click(app, trigger())
    await settle(app)
    expect(item('Bookmark').getAttribute('aria-checked')).toBe('true')
    expect(item('Bookmark').hasAttribute('data-checked')).toBe(true)

    await click(app, item('Dark'))
    await settle(app)
    await click(app, trigger())
    await settle(app)
    expect(item('Light').getAttribute('aria-checked')).toBe('false')
    expect(item('Dark').getAttribute('aria-checked')).toBe('true')
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const opens: boolean[] = []
    const app = mount(() => <Example onOpenChange={(open) => opens.push(open)} />)
    await click(app, trigger())
    await settle(app)
    await press(app, 'Escape')
    await settle(app)
    expect(exists('[role="menu"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
    expect(opens).toEqual([true, false])
  })

  it('closes on a press outside', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await settle(app)
    await click(app, byText('Page text'))
    await settle(app)
    expect(exists('[role="menu"]')).toBe(false)
  })

  it('closes when the trigger is pressed again', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await settle(app)
    await click(app, trigger())
    await settle(app)
    expect(exists('[role="menu"]')).toBe(false)
  })
})
