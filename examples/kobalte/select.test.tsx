import { createSignal } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { Select } from '@kobalte/core/select'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, box, byText, click, exists, focus, isShown, mount, press, query, queryAll, settle, wait } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const FRUITS = ['Apple', 'Banana', 'Cherry', 'Date']

function Example(props: {
  onChange?: (value: string | null) => void
  onOpenChange?: (open: boolean) => void
  defaultValue?: string
  disabledOption?: string
}) {
  return (
    <div style={{ position: 'absolute', top: 80, left: 120, width: 300, height: 300 }}>
      <Select<string>
        options={FRUITS}
        defaultValue={props.defaultValue}
        onChange={props.onChange}
        onOpenChange={props.onOpenChange}
        disallowEmptySelection
        placeholder="Pick a fruit"
        optionDisabled={(option) => option === props.disabledOption}
        gutter={4}
        itemComponent={(item) => (
          <Select.Item item={item.item} style={{ display: 'block', width: 130, height: 24 }}>
            <Select.ItemLabel>{item.item.rawValue}</Select.ItemLabel>
            <Select.ItemIndicator>✓</Select.ItemIndicator>
          </Select.Item>
        )}
      >
        <Select.Trigger data-testid="trigger" aria-label="Fruit" style={{ display: 'block', width: 140, height: 30 }}>
          <Select.Value<string>>{(state) => state.selectedOption()}</Select.Value>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content data-testid="content" style={{ display: 'block', width: 140 }}>
            <Select.Listbox style={{ display: 'block', width: 140, margin: 0, padding: 0 }} />
          </Select.Content>
        </Select.Portal>
      </Select>
      <p style={{ display: 'block', width: 100, height: 30, margin: 0, marginTop: 200 }}>Page text</p>
    </div>
  )
}

function trigger(): HTMLElement {
  return query('[data-testid="trigger"]')
}

function options(): string[] {
  return queryAll('[role="option"]').map((option) => option.textContent ?? '')
}

function option(label: string): HTMLElement {
  return byText(label, '[role="option"]')
}

function activeOption(): string {
  const id = query('[role="listbox"]').getAttribute('aria-activedescendant')
  return id === null ? activeText() : (document.getElementById(id)?.textContent ?? `no element ${id}`)
}

describeNative('Kobalte Select', () => {
  it('shows the placeholder, or the selected value, on the closed trigger', () => {
    mount(() => <Example />)
    expect(trigger().textContent).toBe('Pick a fruit')
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(exists('[role="listbox"]')).toBe(false)
  })

  it('shows the value of the default selection', () => {
    mount(() => <Example defaultValue="Banana" />)
    expect(trigger().textContent).toBe('Banana')
  })

  it('opens a listbox under the trigger on a click, with the options and the selected one marked', async () => {
    const opens: boolean[] = []
    const app = mount(() => <Example defaultValue="Banana" onOpenChange={(open) => opens.push(open)} />)
    await click(app, trigger())
    await settle(app)
    expect(isShown('[role="listbox"]')).toBe(true)
    expect(options()).toEqual(['Apple', 'Banana✓', 'Cherry', 'Date'])
    expect(queryAll('[role="option"]').map((element) => element.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ])
    expect(option('Banana✓').hasAttribute('data-selected')).toBe(true)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(opens).toEqual([true])

    const anchor = box(trigger())
    const content = box(query('[data-testid="content"]'))
    expect(content.y).toBeCloseTo(anchor.y + anchor.height + 4, 0)
    expect(content.x).toBeCloseTo(anchor.x, 0)
  })

  it('picks an option on a click, reports the value, closes, and shows the new value', async () => {
    const values: Array<string | null> = []
    const app = mount(() => <Example onChange={(value) => values.push(value)} />)
    await click(app, trigger())
    await settle(app)
    await click(app, option('Cherry'))
    await settle(app)
    expect(values).toEqual(['Cherry'])
    expect(exists('[role="listbox"]')).toBe(false)
    expect(trigger().textContent).toBe('Cherry')
    expect(document.activeElement).toBe(trigger())
  })

  it('opens from the keyboard with Enter and moves the active option with the arrow keys', async () => {
    const app = mount(() => <Example defaultValue="Banana" />)
    await focus(app, trigger())
    await press(app, 'Enter')
    await settle(app)
    expect(exists('[role="listbox"]')).toBe(true)
    expect(activeOption()).toBe('Banana✓')

    await press(app, 'ArrowDown')
    expect(activeOption()).toBe('Cherry')
    await press(app, 'ArrowDown')
    expect(activeOption()).toBe('Date')
    await press(app, 'ArrowUp')
    expect(activeOption()).toBe('Cherry')
    await press(app, 'Home')
    expect(activeOption()).toBe('Apple')
    await press(app, 'End')
    expect(activeOption()).toBe('Date')
  })

  it('selects the active option with Enter, closes, and returns focus to the trigger', async () => {
    const values: Array<string | null> = []
    const app = mount(() => <Example onChange={(value) => values.push(value)} />)
    await focus(app, trigger())
    await press(app, 'ArrowDown')
    await settle(app)
    expect(exists('[role="listbox"]')).toBe(true)
    await press(app, 'ArrowDown Enter')
    await settle(app)
    expect(values.length).toBe(1)
    expect(exists('[role="listbox"]')).toBe(false)
    expect(trigger().textContent).toBe(values[0])
    expect(document.activeElement).toBe(trigger())
  })

  it('jumps to the option that starts with the typed letters', async () => {
    const app = mount(() => <Example />)
    await focus(app, trigger())
    await press(app, 'Enter')
    await settle(app)
    await press(app, 'd')
    expect(activeOption()).toBe('Date')
    await wait(app, 600)
    await press(app, 'b')
    expect(activeOption()).toBe('Banana')
  })

  it('closes on Escape and returns focus to the trigger without changing the value', async () => {
    const values: Array<string | null> = []
    const app = mount(() => <Example defaultValue="Apple" onChange={(value) => values.push(value)} />)
    await click(app, trigger())
    await settle(app)
    await press(app, 'ArrowDown Escape')
    await settle(app)
    expect(exists('[role="listbox"]')).toBe(false)
    expect(document.activeElement).toBe(trigger())
    expect(trigger().textContent).toBe('Apple')
    expect(values).toEqual([])
  })

  it('closes on a press outside', async () => {
    const app = mount(() => <Example />)
    await click(app, trigger())
    await settle(app)
    expect(exists('[role="listbox"]')).toBe(true)
    await click(app, byText('Page text'))
    await settle(app)
    expect(exists('[role="listbox"]')).toBe(false)
  })

  it('does not select a disabled option', async () => {
    const values: Array<string | null> = []
    const app = mount(() => <Example disabledOption="Cherry" onChange={(value) => values.push(value)} />)
    await click(app, trigger())
    await settle(app)
    expect(option('Cherry').getAttribute('aria-disabled')).toBe('true')
    expect(option('Cherry').hasAttribute('data-disabled')).toBe(true)
    await click(app, option('Cherry'))
    await settle(app)
    expect(values).toEqual([])
    expect(exists('[role="listbox"]')).toBe(true)
  })

  it('follows a controlled value that its owner sets', async () => {
    let setValue!: (value: string) => void
    const app = mount(() => {
      const [value, set] = createSignal('Apple')
      setValue = set
      return (
        <Select<string>
          options={FRUITS}
          value={value()}
          onChange={(next) => next !== null && set(next)}
          itemComponent={(item) => (
            <Select.Item item={item.item} style={{ display: 'block', width: 130, height: 24 }}>
              <Select.ItemLabel>{item.item.rawValue}</Select.ItemLabel>
            </Select.Item>
          )}
        >
          <Select.Trigger data-testid="trigger" style={{ display: 'block', width: 140, height: 30 }}>
            <Select.Value<string>>{(state) => state.selectedOption()}</Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content style={{ display: 'block', width: 140 }}>
              <Select.Listbox />
            </Select.Content>
          </Select.Portal>
        </Select>
      )
    })
    expect(trigger().textContent).toBe('Apple')
    setValue('Date')
    expect(trigger().textContent).toBe('Date')
    await click(app, trigger())
    await settle(app)
    await click(app, option('Banana'))
    await settle(app)
    expect(trigger().textContent).toBe('Banana')
  })
})
