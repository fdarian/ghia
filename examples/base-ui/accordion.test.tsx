import { describe, expect, it } from 'vitest'
import { Accordion } from '@base-ui/react/accordion'
import { hasNativeTestRenderer } from '@ghia/react/testing'
import { activeText, click, focus, mount, press, queryAll } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { multiple?: boolean; onValueChange?: (value: unknown[]) => void }) {
  return (
    <Accordion.Root multiple={props.multiple} onValueChange={props.onValueChange}>
      {['a', 'b', 'c'].map((id) => (
        <Accordion.Item key={id} value={id}>
          <Accordion.Header>
            <Accordion.Trigger>{`Trigger ${id}`}</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Panel>{`Panel ${id}`}</Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  )
}

function expanded(): string[] {
  return queryAll('button').map((button) => button.getAttribute('aria-expanded') ?? '')
}

describeNative('Base UI Accordion', () => {
  it('renders a heading with a button per item, all collapsed', () => {
    mount(<Example />)
    expect(queryAll('h3').length).toBe(3)
    expect(expanded()).toEqual(['false', 'false', 'false'])
  })

  it('opens one item at a time, and reports the value', async () => {
    const values: unknown[][] = []
    const app = mount(<Example onValueChange={(value) => values.push(value)} />)
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

  it('keeps several items open with multiple', async () => {
    const app = mount(<Example multiple />)
    const triggers = queryAll('button')
    await click(app, triggers[0])
    await click(app, triggers[2])
    expect(expanded()).toEqual(['true', 'false', 'true'])
  })

  it('is reached with Tab, and opens an item with Enter and Space', async () => {
    const app = mount(<Example />)
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
})
