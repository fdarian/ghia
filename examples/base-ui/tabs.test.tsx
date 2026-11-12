import { describe, expect, it } from 'vitest'
import { Tabs } from '@base-ui/react/tabs'
import { hasNativeTestRenderer } from '@ghia/react/testing'
import { activeText, click, focus, mount, press, queryAll } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { onValueChange?: (value: unknown) => void; activateOnFocus?: boolean }) {
  return (
    <Tabs.Root defaultValue="a" onValueChange={props.onValueChange}>
      <Tabs.List activateOnFocus={props.activateOnFocus}>
        <Tabs.Tab value="a">Tab A</Tabs.Tab>
        <Tabs.Tab value="b">Tab B</Tabs.Tab>
        <Tabs.Tab value="c">Tab C</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="a">Panel A</Tabs.Panel>
      <Tabs.Panel value="b">Panel B</Tabs.Panel>
      <Tabs.Panel value="c">Panel C</Tabs.Panel>
    </Tabs.Root>
  )
}

function selected(): string[] {
  return queryAll('[role="tab"]').map((tab) => tab.getAttribute('aria-selected') ?? '')
}

describeNative('Base UI Tabs', () => {
  it('shows the panel of the default tab, with the tab and panel roles', () => {
    const app = mount(<Example />)
    expect(queryAll('[role="tablist"]').length).toBe(1)
    expect(selected()).toEqual(['true', 'false', 'false'])
    expect(app.renderer.findByText('Panel A')).toBeDefined()
    expect(app.renderer.findByText('Panel B')).toBeUndefined()
    const tab = queryAll('[role="tab"]')[0]
    expect(queryAll('[role="tabpanel"]')[0].getAttribute('aria-labelledby')).toBe(tab.id)
  })

  it('selects a tab on a click and reports the value', async () => {
    const values: unknown[] = []
    const app = mount(<Example onValueChange={(value) => values.push(value)} />)
    await click(app, queryAll('[role="tab"]')[2])
    expect(selected()).toEqual(['false', 'false', 'true'])
    expect(app.renderer.findByText('Panel C')).toBeDefined()
    expect(app.renderer.findByText('Panel A')).toBeUndefined()
    expect(values).toEqual(['c'])
  })

  it('moves focus with the arrow keys and selects with Enter', async () => {
    const app = mount(<Example />)
    const tabs = queryAll('[role="tab"]')
    await focus(app, tabs[0])
    await press(app, 'ArrowRight')
    expect(activeText()).toBe('Tab B')
    expect(selected()).toEqual(['true', 'false', 'false'])
    await press(app, 'Enter')
    expect(selected()).toEqual(['false', 'true', 'false'])
    expect(app.renderer.findByText('Panel B')).toBeDefined()
    await press(app, 'ArrowLeft ArrowLeft')
    expect(activeText()).toBe('Tab C')
  })

  it('selects as focus moves with activateOnFocus', async () => {
    const app = mount(<Example activateOnFocus />)
    const tabs = queryAll('[role="tab"]')
    await focus(app, tabs[0])
    await press(app, 'ArrowRight')
    expect(selected()).toEqual(['false', 'true', 'false'])
    expect(app.renderer.findByText('Panel B')).toBeDefined()
  })
})
