import { createSignal } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { Button } from '@kobalte/core/button'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { byText, click, focus, mount, press, query } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const SIZE = { display: 'block', width: 120, height: 30 } as const

describeNative('Kobalte Button', () => {
  it('renders a button element with type="button" and takes a click', async () => {
    let clicks = 0
    const app = mount(() => (
      <Button style={SIZE} onClick={() => clicks++}>
        Save
      </Button>
    ))
    const button = byText('Save', 'button')
    expect(button.getAttribute('type')).toBe('button')
    await click(app, button)
    expect(clicks).toBe(1)
    expect(document.activeElement).toBe(button)
  })

  it('activates from the keyboard with Enter and Space', async () => {
    let clicks = 0
    const app = mount(() => (
      <Button style={SIZE} onClick={() => clicks++}>
        Save
      </Button>
    ))
    await focus(app, query('button'))
    await press(app, 'Enter')
    expect(clicks).toBe(1)
    await press(app, 'Space')
    expect(clicks).toBe(2)
  })

  it('marks a disabled button, and neither a click nor a key reaches it', async () => {
    let clicks = 0
    const app = mount(() => (
      <Button style={SIZE} disabled onClick={() => clicks++}>
        Save
      </Button>
    ))
    const button = query('button')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.hasAttribute('data-disabled')).toBe(true)
    await click(app, button)
    await focus(app, button)
    await press(app, 'Enter')
    expect(clicks).toBe(0)
  })

  it('renders a non-button element with role="button" when it is not a native button', async () => {
    const app = mount(() => (
      <Button as="div" style={SIZE}>
        Div button
      </Button>
    ))
    const element = byText('Div button', 'div')
    expect(element.getAttribute('role')).toBe('button')
    expect(element.getAttribute('tabindex')).toBe('0')
    await focus(app, element)
    expect(document.activeElement).toBe(element)
  })

  it('follows its owner: a signal that disables it', async () => {
    let setDisabled!: (value: boolean) => void
    let clicks = 0
    const app = mount(() => {
      const [disabled, set] = createSignal(false)
      setDisabled = set
      return (
        <Button style={SIZE} disabled={disabled()} onClick={() => clicks++}>
          Save
        </Button>
      )
    })
    await click(app, query('button'))
    expect(clicks).toBe(1)
    setDisabled(true)
    await click(app, query('button'))
    expect(query('button').hasAttribute('data-disabled')).toBe(true)
    expect(clicks).toBe(1)
  })
})
