import { describe, expect, it } from 'vitest'
import { Slider } from '@photon-ai/base-ui-solid/slider'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { box, focus, mount, press, query } from '../kobalte/harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: {
  onValueChange?: (value: unknown) => void
  onValueCommitted?: (value: unknown) => void
}) {
  return (
    <Slider.Root
      defaultValue={30}
      min={0}
      max={100}
      step={1}
      largeStep={10}
      onValueChange={props.onValueChange}
      onValueCommitted={props.onValueCommitted}
    >
      <Slider.Control
        data-testid="control"
        style={{ display: 'block', width: '200px', height: '20px', position: 'relative' }}
      >
        <Slider.Track style={{ display: 'block', width: '200px', height: '4px' }}>
          <Slider.Indicator data-testid="indicator" style={{ display: 'block', height: '4px' }} />
          <Slider.Thumb aria-label="Volume" style={{ display: 'block', width: '16px', height: '16px' }} />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  )
}

function thumb(): HTMLInputElement {
  return query('input[type="range"]') as HTMLInputElement
}

describeNative('Base UI Solid Slider', () => {
  it('shows its default value on the thumb input', () => {
    mount(() => <Example />)
    expect(thumb().value).toBe('30')
    expect(thumb().getAttribute('aria-valuenow') ?? thumb().value).toBe('30')
    expect(thumb().getAttribute('aria-label')).toBe('Volume')
  })

  it('changes by a step with the arrow keys, by a large step with PageUp, and to the ends with Home and End', async () => {
    const values: unknown[] = []
    const app = mount(() => <Example onValueChange={(value) => values.push(value)} />)
    await focus(app, thumb())
    await press(app, 'ArrowRight')
    expect(thumb().value).toBe('31')
    await press(app, 'ArrowUp')
    expect(thumb().value).toBe('32')
    await press(app, 'ArrowLeft')
    expect(thumb().value).toBe('31')
    await press(app, 'PageUp')
    expect(thumb().value).toBe('41')
    await press(app, 'End')
    expect(thumb().value).toBe('100')
    await press(app, 'Home')
    expect(thumb().value).toBe('0')
    expect(values).toEqual([31, 32, 31, 41, 100, 0])
  })

  it('moves to where the pointer presses on the control, and reports the commit', async () => {
    const committed: unknown[] = []
    const app = mount(() => <Example onValueCommitted={(value) => committed.push(value)} />)
    const control = box(query('[data-testid="control"]'))
    app.renderer.nativeSimulateClick(control.x + control.width * 0.75, control.y + control.height / 2)
    expect(Number(thumb().value)).toBeGreaterThanOrEqual(74)
    expect(Number(thumb().value)).toBeLessThanOrEqual(76)
    expect(committed.length).toBe(1)
  })

  it('draws the indicator up to the value', async () => {
    const app = mount(() => <Example />)
    await focus(app, thumb())
    await press(app, 'End')
    const indicator = box(query('[data-testid="indicator"]'))
    expect(indicator.width).toBeGreaterThan(150)
  })
})
