import { createSignal } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { Switch } from '@kobalte/core/switch'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { byText, click, focus, mount, press, query } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onChange?: (checked: boolean) => void; defaultChecked?: boolean; disabled?: boolean }) {
  return (
    <div style={{ position: 'absolute', top: 40, left: 40, width: 400, height: 200 }}>
      <Switch
        data-testid="root"
        defaultChecked={props.defaultChecked}
        disabled={props.disabled}
        onChange={props.onChange}
        style={{ display: 'flex', flexDirection: 'row', width: 300, height: 28 }}
      >
        <Switch.Input data-testid="input" />
        <Switch.Control data-testid="control" style={{ display: 'block', width: 40, height: 24 }}>
          <Switch.Thumb data-testid="thumb" style={{ display: 'block', width: 20, height: 20 }} />
        </Switch.Control>
        <Switch.Label style={{ display: 'block', width: 120, height: 24 }}>Airplane mode</Switch.Label>
      </Switch>
    </div>
  )
}

function input(): HTMLInputElement {
  return query('[data-testid="input"]') as HTMLInputElement
}

describeNative('Kobalte Switch', () => {
  it('starts off: role switch, aria-checked false, no data-checked', () => {
    mount(() => <Example />)
    expect(input().getAttribute('role')).toBe('switch')
    expect(input().getAttribute('aria-checked')).toBe('false')
    expect(input().checked).toBe(false)
    expect(query('[data-testid="control"]').hasAttribute('data-checked')).toBe(false)
    expect(query('[data-testid="thumb"]').hasAttribute('data-checked')).toBe(false)
    expect(input().getAttribute('aria-labelledby')).toBe(byText('Airplane mode').id)
  })

  it('toggles on a click on the control and focuses the input', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onChange={(checked) => changes.push(checked)} />)
    await click(app, query('[data-testid="control"]'))
    expect(input().getAttribute('aria-checked')).toBe('true')
    expect(input().checked).toBe(true)
    expect(query('[data-testid="root"]').hasAttribute('data-checked')).toBe(true)
    expect(query('[data-testid="control"]').hasAttribute('data-checked')).toBe(true)
    expect(query('[data-testid="thumb"]').hasAttribute('data-checked')).toBe(true)
    expect(document.activeElement).toBe(input())

    await click(app, query('[data-testid="control"]'))
    expect(input().getAttribute('aria-checked')).toBe('false')
    expect(changes).toEqual([true, false])
  })

  it('toggles on a click on the label, as a <label for> does', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example onChange={(checked) => changes.push(checked)} />)
    await click(app, byText('Airplane mode'))
    expect(input().checked).toBe(true)
    expect(changes).toEqual([true])
  })

  it('toggles with Space on the focused input', async () => {
    const app = mount(() => <Example />)
    await focus(app, input())
    await press(app, 'Space')
    expect(input().getAttribute('aria-checked')).toBe('true')
    await press(app, 'Space')
    expect(input().getAttribute('aria-checked')).toBe('false')
  })

  it('is reached by Tab', async () => {
    const app = mount(() => <Example />)
    await press(app, 'Tab')
    expect(document.activeElement).toBe(input())
  })

  it('does nothing when disabled', async () => {
    const changes: boolean[] = []
    const app = mount(() => <Example disabled onChange={(checked) => changes.push(checked)} />)
    expect(input().disabled).toBe(true)
    expect(query('[data-testid="control"]').hasAttribute('data-disabled')).toBe(true)
    await click(app, query('[data-testid="control"]'))
    expect(input().checked).toBe(false)
    expect(changes).toEqual([])
  })

  it('follows a controlled value that its owner sets', async () => {
    let setChecked!: (value: boolean) => void
    const app = mount(() => {
      const [checked, set] = createSignal(true)
      setChecked = set
      return (
        <Switch checked={checked()} onChange={(next) => set(next)} style={{ display: 'flex', width: 200, height: 24 }}>
          <Switch.Input data-testid="input" />
          <Switch.Control data-testid="control" style={{ display: 'block', width: 40, height: 24 }} />
        </Switch>
      )
    })
    expect(input().getAttribute('aria-checked')).toBe('true')
    setChecked(false)
    expect(input().getAttribute('aria-checked')).toBe('false')
    await click(app, query('[data-testid="control"]'))
    expect(input().getAttribute('aria-checked')).toBe('true')
  })
})
