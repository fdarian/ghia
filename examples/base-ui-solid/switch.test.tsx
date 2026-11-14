import { describe, expect, it } from 'vitest'
import { Switch } from '@photon-ai/base-ui-solid/switch'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { byText, click, focus, mount, press, query } from '../kobalte/harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onCheckedChange?: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label style={{ display: 'flex', gap: '8px', width: '200px', height: '24px' }}>
      <Switch.Root
        onCheckedChange={props.onCheckedChange}
        disabled={props.disabled}
        style={{ display: 'block', width: '40px', height: '20px' }}
      >
        <Switch.Thumb style={{ display: 'block', width: '16px', height: '16px' }} />
      </Switch.Root>
      <span>Notifications</span>
    </label>
  )
}

describeNative('Base UI Solid Switch', () => {
  it('is an unchecked switch that a click toggles, reporting each value', async () => {
    const values: boolean[] = []
    const app = mount(() => <Example onCheckedChange={(checked) => values.push(checked)} />)
    const control = query('[role="switch"]')
    expect(control.getAttribute('aria-checked')).toBe('false')
    expect(control.hasAttribute('data-unchecked')).toBe(true)

    await click(app, control)
    expect(control.getAttribute('aria-checked')).toBe('true')
    expect(control.hasAttribute('data-checked')).toBe(true)
    expect(query('input[type="checkbox"]').matches(':checked')).toBe(true)

    await click(app, control)
    expect(control.getAttribute('aria-checked')).toBe('false')
    expect(values).toEqual([true, false])
  })

  it('toggles with Space when focused', async () => {
    const app = mount(() => <Example />)
    const control = query('[role="switch"]')
    await focus(app, control)
    await press(app, 'Space')
    expect(control.getAttribute('aria-checked')).toBe('true')
    await press(app, 'Space')
    expect(control.getAttribute('aria-checked')).toBe('false')
  })

  it('toggles from a click on its label', async () => {
    const app = mount(() => <Example />)
    await click(app, byText('Notifications', 'span'))
    expect(query('[role="switch"]').getAttribute('aria-checked')).toBe('true')
  })

  it('ignores clicks while disabled', async () => {
    const values: boolean[] = []
    const app = mount(() => <Example disabled onCheckedChange={(checked) => values.push(checked)} />)
    const control = query('[role="switch"]')
    await click(app, control)
    expect(control.getAttribute('aria-checked')).toBe('false')
    expect((control as HTMLButtonElement).disabled).toBe(true)
    expect(control.hasAttribute('data-disabled')).toBe(true)
    expect(values).toEqual([])
  })
})
