import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Input } from '@base-ui/react/input'
import { hasNativeTestRenderer } from '@ghia/react/testing'
import { click, focus, mount, press, query } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('Base UI Input', () => {
  it('takes typed text and reports each change', async () => {
    const values: string[] = []
    const app = mount(
      <Input
        defaultValue=""
        placeholder="Name"
        style={{ display: 'block', width: 200, height: 24 }}
        onValueChange={(value) => values.push(value)}
      />,
    )
    const input = query('input')
    await click(app, input)
    expect(document.activeElement).toBe(input)
    await press(app, 'h i')
    expect((input as HTMLInputElement).value).toBe('hi')
    await press(app, 'Backspace')
    expect((input as HTMLInputElement).value).toBe('h')
    expect(values).toEqual(['h', 'hi', 'h'])
  })

  it('shows its default value, and is not editable while disabled', async () => {
    const app = mount(
      <Input defaultValue="fixed" disabled style={{ display: 'block', width: 200, height: 24 }} />,
    )
    const input = query('input') as HTMLInputElement
    expect(input.value).toBe('fixed')
    expect(input.disabled).toBe(true)
    await click(app, input)
    await press(app, 'x')
    expect(input.value).toBe('fixed')
  })

  it('shows a controlled value that follows its owner', async () => {
    function Controlled() {
      const [value, setValue] = useState('a')
      return (
        <>
          <Input value={value} onValueChange={(next) => setValue(next.toUpperCase())} style={{ display: 'block', width: 200, height: 24 }} />
          <span>{`State: ${value}`}</span>
        </>
      )
    }
    const app = mount(<Controlled />)
    const input = query('input') as HTMLInputElement
    await focus(app, input)
    await press(app, 'End')
    await press(app, 'b')
    expect(input.value).toBe('AB')
    expect(app.renderer.findByText('State: AB')).toBeDefined()
  })
})
