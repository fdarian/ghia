import { describe, expect, it } from 'vitest'
import { Checkbox } from '@photon-ai/base-ui-solid/checkbox'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { byText, click, exists, focus, mount, press, query } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onCheckedChange?: (checked: boolean) => void; indeterminate?: boolean }) {
  return (
    <label style={{ display: 'flex', gap: '8px', width: '200px', height: '24px' }}>
      <Checkbox.Root
        onCheckedChange={props.onCheckedChange}
        indeterminate={props.indeterminate}
        style={{ display: 'block', width: '20px', height: '20px' }}
      >
        <Checkbox.Indicator style={{ display: 'block', width: '10px', height: '10px' }} />
      </Checkbox.Root>
      <span>Accept</span>
    </label>
  )
}

describeNative('Base UI Solid Checkbox', () => {
  it('checks and unchecks on a click, showing the indicator only while checked', async () => {
    const values: boolean[] = []
    const app = mount(() => <Example onCheckedChange={(checked) => values.push(checked)} />)
    const box = query('[role="checkbox"]')
    expect(box.getAttribute('aria-checked')).toBe('false')
    expect(box.children.length).toBe(0)

    await click(app, box)
    expect(box.getAttribute('aria-checked')).toBe('true')
    expect(box.hasAttribute('data-checked')).toBe(true)
    expect(box.children.length).toBe(1)

    await click(app, box)
    expect(box.getAttribute('aria-checked')).toBe('false')
    expect(box.children.length).toBe(0)
    expect(values).toEqual([true, false])
  })

  it('toggles with Space and from a click on its label', async () => {
    const app = mount(() => <Example />)
    const box = query('[role="checkbox"]')
    await focus(app, box)
    await press(app, 'Space')
    expect(box.getAttribute('aria-checked')).toBe('true')
    await click(app, byText('Accept', 'span'))
    expect(box.getAttribute('aria-checked')).toBe('false')
  })

  it('reports an indeterminate box as mixed', () => {
    mount(() => <Example indeterminate />)
    expect(query('[role="checkbox"]').getAttribute('aria-checked')).toBe('mixed')
    expect(exists('[data-indeterminate]')).toBe(true)
  })
})
