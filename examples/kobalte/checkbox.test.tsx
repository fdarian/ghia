import { createSignal } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { Checkbox } from '@kobalte/core/checkbox'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { byText, click, exists, focus, mount, press, query } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: {
  onChange?: (checked: boolean) => void
  defaultChecked?: boolean
  indeterminate?: boolean
  disabled?: boolean
}) {
  return (
    <div style={{ position: 'absolute', top: 40, left: 40, width: 400, height: 200 }}>
      <Checkbox
        data-testid="root"
        defaultChecked={props.defaultChecked}
        indeterminate={props.indeterminate}
        disabled={props.disabled}
        onChange={props.onChange}
        style={{ display: 'flex', flexDirection: 'row', width: 300, height: 24 }}
      >
        <Checkbox.Input data-testid="input" />
        <Checkbox.Control data-testid="control" style={{ display: 'block', width: 20, height: 20 }}>
          <Checkbox.Indicator data-testid="indicator" style={{ display: 'block', width: 10, height: 10 }} />
        </Checkbox.Control>
        <Checkbox.Label style={{ display: 'block', width: 120, height: 20 }}>Accept terms</Checkbox.Label>
      </Checkbox>
    </div>
  )
}

function input(): HTMLInputElement {
  return query('[data-testid="input"]') as HTMLInputElement
}

describeNative('Kobalte Checkbox', () => {
  it('starts unchecked: a checkbox input, no indicator, no data-checked, labelled by its label', () => {
    mount(() => <Example />)
    expect(input().type).toBe('checkbox')
    expect(input().checked).toBe(false)
    expect(query('[data-testid="root"]').hasAttribute('data-checked')).toBe(false)
    expect(query('[data-testid="control"]').hasAttribute('data-checked')).toBe(false)
    expect(exists('[data-testid="indicator"]')).toBe(false)
    expect(input().getAttribute('aria-labelledby')).toBe(byText('Accept terms').id)
  })

  it('toggles on a click on the control: the input, data-checked and the indicator follow', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onChange={(checked) => changes.push(checked)} />)
    await click(app, query('[data-testid="control"]'))
    expect(input().checked).toBe(true)
    expect(query('[data-testid="root"]').hasAttribute('data-checked')).toBe(true)
    expect(query('[data-testid="control"]').hasAttribute('data-checked')).toBe(true)
    expect(exists('[data-testid="indicator"]')).toBe(true)
    expect(document.activeElement).toBe(input())
    expect(changes).toEqual([true])

    await click(app, query('[data-testid="control"]'))
    expect(input().checked).toBe(false)
    expect(exists('[data-testid="indicator"]')).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it('toggles on a click on the label, as a <label for> does', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onChange={(checked) => changes.push(checked)} />)
    expect(byText('Accept terms').localName).toBe('label')
    await click(app, byText('Accept terms'))
    expect(input().checked).toBe(true)
    expect(changes).toEqual([true])
  })

  it('toggles with Space on the focused input', async () => {
    const app = mount(() => <Example />)
    await focus(app, input())
    await press(app, 'Space')
    expect(input().checked).toBe(true)
    expect(query('[data-testid="root"]').hasAttribute('data-checked')).toBe(true)
    await press(app, 'Space')
    expect(input().checked).toBe(false)
  })

  it('is reached by Tab', async () => {
    const app = mount(() => <Example />)
    await press(app, 'Tab')
    expect(document.activeElement).toBe(input())
  })

  it('reports indeterminate through the input property and data-indeterminate, and a click resolves it to checked', async () => {
    const app = mount(() => <Example indeterminate />)
    expect(input().indeterminate).toBe(true)
    expect(query('[data-testid="control"]').hasAttribute('data-indeterminate')).toBe(true)
    expect(exists('[data-testid="indicator"]')).toBe(true)
    await click(app, query('[data-testid="control"]'))
    expect(input().checked).toBe(true)
  })

  it('does nothing when disabled', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example disabled onChange={(checked) => changes.push(checked)} />)
    expect(input().disabled).toBe(true)
    expect(query('[data-testid="control"]').hasAttribute('data-disabled')).toBe(true)
    await click(app, query('[data-testid="control"]'))
    await click(app, byText('Accept terms'))
    expect(input().checked).toBe(false)
    expect(changes).toEqual([])
  })

  it('follows a controlled value that its owner sets', async () => {
    let setChecked!: (value: boolean) => void
    const app = mount(() => {
      const [checked, set] = createSignal(false)
      setChecked = set
      return (
        <Checkbox checked={checked()} onChange={(next) => set(next)} style={{ display: 'flex', width: 200, height: 24 }}>
          <Checkbox.Input data-testid="input" />
          <Checkbox.Control data-testid="control" style={{ display: 'block', width: 20, height: 20 }} />
        </Checkbox>
      )
    })
    setChecked(true)
    expect(input().checked).toBe(true)
    await click(app, query('[data-testid="control"]'))
    expect(input().checked).toBe(false)
  })
})
