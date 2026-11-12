import { describe, expect, it } from 'vitest'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { hasNativeTestRenderer } from '@ghia/react/testing'
import { click, focus, mount, press, queryAll, byText } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onValueChange?: (value: unknown) => void }) {
  return (
    <RadioGroup defaultValue="small" onValueChange={props.onValueChange} aria-label="Size">
      {['small', 'medium', 'large'].map((size) => (
        <label key={size} style={{ display: 'flex', gap: 8, width: 160, height: 24 }}>
          <Radio.Root value={size} style={{ display: 'block', width: 20, height: 20 }}>
            <Radio.Indicator style={{ display: 'block', width: 8, height: 8 }} />
          </Radio.Root>
          <span>{size}</span>
        </label>
      ))}
    </RadioGroup>
  )
}

function checked(): string[] {
  return queryAll('[role="radio"]').map((radio) => radio.getAttribute('aria-checked') ?? '')
}

describeNative('Base UI RadioGroup', () => {
  it('renders a radiogroup with the default value checked', () => {
    mount(<Example />)
    expect(queryAll('[role="radiogroup"]').length).toBe(1)
    expect(checked()).toEqual(['true', 'false', 'false'])
  })

  it('selects a radio on a click and reports the value', async () => {
    const values: unknown[] = []
    const app = mount(<Example onValueChange={(value) => values.push(value)} />)
    await click(app, queryAll('[role="radio"]')[2])
    expect(checked()).toEqual(['false', 'false', 'true'])
    expect(values).toEqual(['large'])
  })

  it('selects from a click on the label', async () => {
    const app = mount(<Example />)
    await click(app, byText('medium', 'span'))
    expect(checked()).toEqual(['false', 'true', 'false'])
  })

  it('moves the selection with the arrow keys', async () => {
    const values: unknown[] = []
    const app = mount(<Example onValueChange={(value) => values.push(value)} />)
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
