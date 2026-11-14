import { describe, expect, it } from 'vitest'
import { Combobox } from '@kobalte/core/combobox'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { box, byText, click, exists, focus, isShown, mount, press, query, queryAll, settle, wait } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const FRUITS = ['Apple', 'Apricot', 'Banana', 'Cherry', 'Date']

function Example(props: { onChange?: (value: string | null) => void; onInputChange?: (value: string) => void; defaultValue?: string }) {
  return (
    <div style={{ position: 'absolute', top: 80, left: 120, width: 320, height: 320 }}>
      <Combobox<string>
        options={FRUITS}
        defaultValue={props.defaultValue}
        onChange={props.onChange}
        onInputChange={props.onInputChange}
        placeholder="Search fruit"
        gutter={4}
        itemComponent={(item) => (
          <Combobox.Item item={item.item} style={{ display: 'block', width: 160, height: 24 }}>
            <Combobox.ItemLabel>{item.item.rawValue}</Combobox.ItemLabel>
          </Combobox.Item>
        )}
      >
        <Combobox.Control aria-label="Fruit" style={{ display: 'flex', flexDirection: 'row', width: 200, height: 30 }}>
          <Combobox.Input style={{ display: 'block', width: 160, height: 30 }} />
          <Combobox.Trigger data-testid="trigger" style={{ display: 'block', width: 30, height: 30 }}>
            v
          </Combobox.Trigger>
        </Combobox.Control>
        <Combobox.Portal>
          <Combobox.Content data-testid="content" style={{ display: 'block', width: 200 }}>
            <Combobox.Listbox style={{ display: 'block', width: 200, margin: 0, padding: 0 }} />
          </Combobox.Content>
        </Combobox.Portal>
      </Combobox>
      <p style={{ display: 'block', width: 100, height: 30, margin: 0, marginTop: 220 }}>Page text</p>
    </div>
  )
}

function input(): HTMLInputElement {
  return query('input') as HTMLInputElement
}

function options(): string[] {
  return queryAll('[role="option"]').map((option) => option.textContent ?? '')
}

function activeOption(): string {
  const id = input().getAttribute('aria-activedescendant')
  if (id === null) return `no active descendant (focus on ${document.activeElement?.localName})`
  return document.getElementById(id)?.textContent ?? `no element ${id}`
}

describeNative('Kobalte Combobox', () => {
  it('renders an input with the combobox role, collapsed, with its placeholder', () => {
    mount(() => <Example />)
    expect(input().getAttribute('role')).toBe('combobox')
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input().getAttribute('aria-haspopup')).toBe('listbox')
    expect(input().getAttribute('aria-autocomplete')).toBe('list')
    expect(input().placeholder).toBe('Search fruit')
    expect(exists('[role="listbox"]')).toBe(false)
  })

  it('shows the label of the default value in the input', () => {
    mount(() => <Example defaultValue="Cherry" />)
    expect(input().value).toBe('Cherry')
  })

  it('opens the listbox on the trigger, under the control, with every option and focus on the input', async () => {
    const app = mount(() => <Example />)
    await click(app, query('[data-testid="trigger"]'))
    await settle(app)
    expect(isShown('[role="listbox"]')).toBe(true)
    expect(options()).toEqual(FRUITS)
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(input())

    const anchor = box(query('[aria-label="Fruit"]'))
    const content = box(query('[data-testid="content"]'))
    expect(content.y).toBeCloseTo(anchor.y + anchor.height + 4, 0)
  })

  it('opens and filters the options as text is typed, and reports each input change', async () => {
    const inputs: string[] = []
    const app = mount(() => <Example onInputChange={(value) => inputs.push(value)} />)
    await click(app, input())
    expect(document.activeElement).toBe(input())
    await press(app, 'a p')
    await settle(app)
    expect(input().value).toBe('ap')
    expect(options()).toEqual(['Apple', 'Apricot'])
    expect(inputs).toEqual(['a', 'ap'])

    await press(app, 'r')
    expect(options()).toEqual(['Apricot'])
    await press(app, 'Backspace Backspace Backspace')
    expect(input().value).toBe('')
    expect(options()).toEqual(FRUITS)
  })

  it('moves the active option with the arrow keys while focus stays on the input, and selects with Enter', async () => {
    const values: Array<string | null> = []
    const app = mount(() => <Example onChange={(value) => values.push(value)} />)
    await focus(app, input())
    await press(app, 'ArrowDown')
    await settle(app)
    expect(exists('[role="listbox"]')).toBe(true)
    expect(activeOption()).toBe('Apple')
    await press(app, 'ArrowDown')
    expect(activeOption()).toBe('Apricot')
    expect(document.activeElement).toBe(input())
    await press(app, 'ArrowDown ArrowDown')
    expect(activeOption()).toBe('Cherry')
    await press(app, 'Enter')
    await settle(app)
    expect(values).toEqual(['Cherry'])
    expect(input().value).toBe('Cherry')
    expect(exists('[role="listbox"]')).toBe(false)
  })

  it('picks an option on a click, fills the input and closes', async () => {
    const values: Array<string | null> = []
    const app = mount(() => <Example onChange={(value) => values.push(value)} />)
    await click(app, query('[data-testid="trigger"]'))
    await settle(app)
    await click(app, byText('Banana', '[role="option"]'))
    await settle(app)
    expect(values).toEqual(['Banana'])
    expect(input().value).toBe('Banana')
    expect(exists('[role="listbox"]')).toBe(false)
  })

  it('marks the selected option with aria-selected and data-selected', async () => {
    const app = mount(() => <Example defaultValue="Date" />)
    await click(app, query('[data-testid="trigger"]'))
    await settle(app)
    const selected = queryAll('[role="option"]').filter((option) => option.getAttribute('aria-selected') === 'true')
    expect(selected.map((option) => option.textContent)).toEqual(['Date'])
    expect(selected[0].hasAttribute('data-selected')).toBe(true)
  })

  it('closes on Escape, and keeps the typed text until Escape is pressed again', async () => {
    const app = mount(() => <Example />)
    await click(app, input())
    await press(app, 'b')
    await settle(app)
    expect(options()).toEqual(['Banana'])
    await press(app, 'Escape')
    await settle(app)
    expect(exists('[role="listbox"]')).toBe(false)
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on a press outside', async () => {
    const app = mount(() => <Example />)
    await click(app, query('[data-testid="trigger"]'))
    await settle(app)
    expect(exists('[role="listbox"]')).toBe(true)
    await click(app, byText('Page text'))
    await settle(app)
    expect(exists('[role="listbox"]')).toBe(false)
  })

  it('shows nothing selectable when no option matches', async () => {
    const app = mount(() => <Example />)
    await click(app, input())
    await press(app, 'z')
    await settle(app)
    expect(options()).toEqual([])
  })
})
