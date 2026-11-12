import { describe, expect, it } from 'vitest'
import { Button } from '@base-ui/react/button'
import { hasNativeTestRenderer } from '@ghia/react/testing'
import { click, focus, mount, press, query } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('Base UI Button', () => {
  it('fires onClick on a pointer click, Enter and Space', async () => {
    let clicks = 0
    const app = mount(<Button onClick={() => clicks++}>Save</Button>)
    const button = query('button')
    expect(button.textContent).toBe('Save')

    await click(app, button)
    expect(clicks).toBe(1)

    await focus(app, button)
    expect(document.activeElement).toBe(button)
    await press(app, 'Enter')
    expect(clicks).toBe(2)
    await press(app, 'Space')
    expect(clicks).toBe(3)
  })

  it('does nothing while disabled, and stays out of the tab order', async () => {
    let clicks = 0
    const app = mount(
      <Button disabled onClick={() => clicks++}>
        Save
      </Button>,
    )
    const button = query('button')
    expect(button.hasAttribute('disabled')).toBe(true)
    await click(app, button)
    expect(clicks).toBe(0)
  })

  it('is a button element with role button when it renders a div', async () => {
    let clicks = 0
    const app = mount(
      <Button nativeButton={false} render={<div style={{ width: 80, height: 24 }} />} onClick={() => clicks++}>
        Div
      </Button>,
    )
    const button = query('[role="button"]')
    expect(button.localName).toBe('div')
    expect(button.getAttribute('tabindex')).toBe('0')
    await click(app, button)
    expect(clicks).toBe(1)
    await focus(app, button)
    await press(app, 'Enter')
    await press(app, 'Space')
    expect(clicks).toBe(3)
  })
})
