import { For } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { Accordion } from '@photon-ai/base-ui-solid/accordion'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, click, focus, mount, press, queryAll } from '../kobalte/harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

// `openMultiple` defaults to true in the Solid ports (the React package's `multiple` defaults to false).
function Example(props: { openMultiple?: boolean; onValueChange?: (value: unknown[]) => void }) {
  return (
    <Accordion.Root openMultiple={props.openMultiple} onValueChange={props.onValueChange}>
      <For each={['a', 'b', 'c']}>
        {(id) => (
          <Accordion.Item value={id}>
            <Accordion.Header>
              <Accordion.Trigger>{`Trigger ${id}`}</Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Panel>{`Panel ${id}`}</Accordion.Panel>
          </Accordion.Item>
        )}
      </For>
    </Accordion.Root>
  )
}

function expanded(): string[] {
  return queryAll('button').map((button) => button.getAttribute('aria-expanded') ?? '')
}

describeNative('Base UI Solid Accordion', () => {
  it('renders a heading with a button per item, all collapsed', () => {
    mount(() => <Example />)
    expect(queryAll('h3').length).toBe(3)
    expect(expanded()).toEqual(['false', 'false', 'false'])
  })

  it('opens one item at a time with openMultiple off, and reports the value', async () => {
    const values: unknown[][] = []
    const app = mount(() => <Example openMultiple={false} onValueChange={(value) => values.push(value)} />)
    const triggers = queryAll('button')

    await click(app, triggers[0])
    expect(expanded()).toEqual(['true', 'false', 'false'])
    expect(app.renderer.findByText('Panel a')).toBeDefined()

    await click(app, triggers[1])
    expect(expanded()).toEqual(['false', 'true', 'false'])
    expect(app.renderer.findByText('Panel a')).toBeUndefined()
    expect(app.renderer.findByText('Panel b')).toBeDefined()
    expect(values).toEqual([['a'], ['b']])
  })

  it('keeps several items open by default', async () => {
    const app = mount(() => <Example />)
    const triggers = queryAll('button')
    await click(app, triggers[0])
    await click(app, triggers[2])
    expect(expanded()).toEqual(['true', 'false', 'true'])
  })

  it('is reached with Tab, and opens an item with Enter and Space', async () => {
    const app = mount(() => <Example openMultiple={false} />)
    const triggers = queryAll('button')
    await focus(app, triggers[0])
    await press(app, 'Tab')
    expect(activeText()).toBe('Trigger b')
    await press(app, 'Enter')
    expect(expanded()).toEqual(['false', 'true', 'false'])
    await press(app, 'Tab')
    expect(activeText()).toBe('Trigger c')
    await press(app, 'Space')
    expect(expanded()).toEqual(['false', 'false', 'true'])
    await press(app, 'Shift+Tab')
    expect(activeText()).toBe('Trigger b')
  })

  it('moves focus between triggers with the arrow keys, Home and End, wrapping', async () => {
    const app = mount(() => <Example />)
    await focus(app, queryAll('button')[0])
    await press(app, 'ArrowDown')
    expect(activeText()).toBe('Trigger b')
    await press(app, 'End')
    expect(activeText()).toBe('Trigger c')
    await press(app, 'ArrowDown')
    expect(activeText()).toBe('Trigger a')
    await press(app, 'ArrowUp')
    expect(activeText()).toBe('Trigger c')
    await press(app, 'Home')
    expect(activeText()).toBe('Trigger a')
    expect(expanded()).toEqual(['false', 'false', 'false'])
  })

  it('links a trigger to its panel by aria-controls and aria-labelledby', async () => {
    const app = mount(() => <Example />)
    const trigger = queryAll('button')[1]
    await click(app, trigger)
    const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('role')).toBe('region')
    expect(panel?.getAttribute('aria-labelledby')).toBe(trigger.id)
  })
})
