import { For } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { Select } from '@photon-ai/base-ui-solid/select'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, box, byText, click, exists, focus, isShown, mount, press, query, queryAll, settle } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const FRUITS = [
  { label: 'Apple', value: 'apple' },
  { label: 'Banana', value: 'banana' },
  { label: 'Cherry', value: 'cherry' },
]

function Example(props: { onValueChange?: (value: unknown) => void; onOpenChange?: (open: boolean) => void }) {
  return (
    <div style={{ position: 'absolute', top: '80px', left: '120px', width: '300px', height: '300px' }}>
      <Select.Root
        items={FRUITS}
        defaultValue="apple"
        onValueChange={props.onValueChange}
        onOpenChange={props.onOpenChange}
      >
        <Select.Trigger aria-label="Fruit" style={{ display: 'block', width: '140px', height: '30px' }}>
          <Select.Value />
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={4} alignItemWithTrigger={false}>
            <Select.Popup data-testid="popup" style={{ display: 'block', width: '140px' }}>
              <For each={FRUITS}>
                {(fruit) => (
                  <Select.Item value={fruit.value} style={{ display: 'block', width: '130px', height: '24px' }}>
                    <Select.ItemText>{fruit.label}</Select.ItemText>
                  </Select.Item>
                )}
              </For>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      <p style={{ display: 'block', width: '100px', height: '30px', margin: '0px', marginTop: '200px' }}>Page text</p>
    </div>
  )
}

function trigger(): HTMLElement {
  return query('button[aria-label="Fruit"], [role="combobox"]')
}

function options(): string[] {
  return queryAll('[role="option"]').map((option) => option.textContent ?? '')
}

describeNative('Base UI Solid Select', () => {
  it('shows the label of the selected item on the closed trigger, from the items it was given', () => {
    mount(() => <Example />)
    expect(trigger().textContent).toBe('Apple')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(isShown('[role="listbox"]')).toBe(false)
  })

  it('opens a listbox under the trigger with the options, marking the selected one', async () => {
    const opens: boolean[] = []
    const app = mount(() => <Example onOpenChange={(open) => opens.push(open)} />)
    await click(app, trigger())
    await settle(app)
    expect(isShown('[role="listbox"]')).toBe(true)
    expect(options()).toEqual(['Apple', 'Banana', 'Cherry'])
    expect(queryAll('[role="option"]').map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(opens).toEqual([true])

    const anchor = box(trigger())
    const popup = box(query('[data-testid="popup"]'))
    expect(popup.y).toBeCloseTo(anchor.y + anchor.height + 4, 0)
    expect(popup.x).toBeCloseTo(anchor.x, 0)
  })

  it('picks an option on a click, reports the value, closes, and shows the new label', async () => {
    const values: unknown[] = []
    const app = mount(() => <Example onValueChange={(value) => values.push(value)} />)
    await click(app, trigger())
    await settle(app)
    await click(app, byText('Cherry', '[role="option"]'))
    await settle(app)
    expect(values).toEqual(['cherry'])
    expect(isShown('[role="listbox"]')).toBe(false)
    expect(trigger().textContent).toBe('Cherry')
  })

  it('returns focus to the trigger after a click picks an option', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await settle(app)
    await click(app, byText('Cherry', '[role="option"]'))
    await settle(app)
    expect(document.activeElement).toBe(trigger())
  })

  it('leaves no open-state attribute on the trigger or the popup after a pick', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await settle(app)
    expect(trigger().hasAttribute('data-popup-open')).toBe(true)
    await click(app, byText('Cherry', '[role="option"]'))
    await settle(app)
    const stale = ['data-open', 'data-starting-style', 'data-ending-style', 'data-popup-open', 'data-pressed']
    const popup = query('[role="listbox"]')
    expect([trigger(), popup].flatMap((el) => stale.filter((name) => el.hasAttribute(name)).map((name) => `${el.tagName}:${name}`))).toEqual([])
  })

  it('picks with the keyboard: ArrowDown opens, the arrows move the highlight, Enter picks', async () => {
    const values: unknown[] = []
    const app = mount(() => <Example onValueChange={(value) => values.push(value)} />)
    await focus(app, trigger())
    await press(app, 'ArrowDown')
    await settle(app)
    expect(isShown('[role="listbox"]')).toBe(true)
    expect(activeText()).toBe('Apple')
    await press(app, 'ArrowDown')
    expect(activeText()).toBe('Banana')
    await press(app, 'ArrowDown')
    expect(activeText()).toBe('Cherry')
    await press(app, 'ArrowUp')
    expect(activeText()).toBe('Banana')
    await press(app, 'Enter')
    await settle(app)
    expect(values).toEqual(['banana'])
    expect(trigger().textContent).toBe('Banana')
    expect(isShown('[role="listbox"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
  })

  it('leaves data-highlighted on only the option that holds the highlight', async () => {
    const app = mount(() => <Example />)
    await focus(app, trigger())
    await press(app, 'ArrowDown')
    await settle(app)
    await press(app, 'ArrowDown')
    expect(queryAll('[role="option"][data-highlighted]').map((option) => option.textContent)).toEqual(['Banana'])
  })

  it('highlights an option by typing its name', async () => {
    const app = mount(() => <Example />)
    await focus(app, trigger())
    await press(app, 'ArrowDown')
    await settle(app)
    await press(app, 'c')
    expect(activeText()).toBe('Cherry')
  })

  it('closes on Escape without picking, returning focus to the trigger', async () => {
    const values: unknown[] = []
    const app = mount(() => <Example onValueChange={(value) => values.push(value)} />)
    await click(app, trigger())
    await settle(app)
    await press(app, 'ArrowDown')
    await press(app, 'Escape')
    await settle(app)
    expect(isShown('[role="listbox"]')).toBe(false)
    expect(values).toEqual([])
    expect(trigger().textContent).toBe('Apple')
    expect(document.activeElement).toBe(trigger())
  })

  it('closes on a press outside', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await settle(app)
    await click(app, byText('Page text'))
    await settle(app)
    expect(isShown('[role="listbox"]')).toBe(false)
  })
})
