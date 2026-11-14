import { For } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { Radio } from '@photon-ai/base-ui-solid/radio'
import { RadioGroup } from '@photon-ai/base-ui-solid/radio-group'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { byText, click, focus, mount, press, queryAll } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onValueChange?: (value: unknown) => void }) {
  return (
    <RadioGroup defaultValue="small" onValueChange={props.onValueChange} aria-label="Size">
      <For each={['small', 'medium', 'large']}>
        {(size) => (
          <label style={{ display: 'flex', gap: '8px', width: '160px', height: '24px' }}>
            <Radio.Root value={size} style={{ display: 'block', width: '20px', height: '20px' }}>
              <Radio.Indicator style={{ display: 'block', width: '8px', height: '8px' }} />
            </Radio.Root>
            <span>{size}</span>
          </label>
        )}
      </For>
    </RadioGroup>
  )
}

function checked(): string[] {
  return queryAll('[role="radio"]').map((radio) => radio.getAttribute('aria-checked') ?? '')
}

describeNative('Base UI Solid RadioGroup', () => {
  it('renders a radiogroup with the default value checked', () => {
    mount(() => <Example />)
    expect(queryAll('[role="radiogroup"]').length).toBe(1)
    expect(checked()).toEqual(['true', 'false', 'false'])
  })

  it('selects a radio on a click and reports the value', async () => {
    const values: unknown[] = []
    const app = mount(() => <Example onValueChange={(value) => values.push(value)} />)
    await click(app, queryAll('[role="radio"]')[2])
    expect(checked()).toEqual(['false', 'false', 'true'])
    expect(values).toEqual(['large'])
  })

  it('selects from a click on the label', async () => {
    const app = mount(() => <Example />)
    await click(app, byText('medium', 'span'))
    expect(checked()).toEqual(['false', 'true', 'false'])
  })

  it('moves the selection with the arrow keys', async () => {
    const values: unknown[] = []
    const app = mount(() => <Example onValueChange={(value) => values.push(value)} />)
    await focus(app, queryAll('[role="radio"]')[0])
    await press(app, 'ArrowDown')
    expect(checked()).toEqual(['false', 'true', 'false'])
    expect(document.activeElement?.getAttribute('role')).toBe('radio')
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('true')
    await press(app, 'ArrowDown ArrowDown')
    expect(checked()).toEqual(['true', 'false', 'false'])
    await press(app, 'ArrowUp')
    expect(checked()).toEqual(['false', 'false', 'true'])
    expect(values).toEqual(['medium', 'large', 'small', 'large'])
  })
})
