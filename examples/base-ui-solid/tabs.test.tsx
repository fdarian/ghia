import { describe, expect, it } from 'vitest'
import { Tabs } from '@photon-ai/base-ui-solid/tabs'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, click, focus, mount, press, queryAll } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

// `activateOnFocus` defaults to true in the Solid ports (the React package's defaults to false).
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

describeNative('Base UI Solid Tabs', () => {
  it('shows the panel of the default tab, with the tab and panel roles', () => {
    const app = mount(() => <Example />)
    expect(queryAll('[role="tablist"]').length).toBe(1)
    expect(selected()).toEqual(['true', 'false', 'false'])
    expect(app.renderer.findByText('Panel A')).toBeDefined()
    expect(app.renderer.findByText('Panel B')).toBeUndefined()
    const tab = queryAll('[role="tab"]')[0]
    expect(queryAll('[role="tabpanel"]')[0].getAttribute('aria-labelledby')).toBe(tab.id)
  })

  it('selects a tab on a click and reports the value', async () => {
    const values: unknown[] = []
    const app = mount(() => <Example onValueChange={(value) => values.push(value)} />)
    await click(app, queryAll('[role="tab"]')[2])
    expect(selected()).toEqual(['false', 'false', 'true'])
    expect(app.renderer.findByText('Panel C')).toBeDefined()
    expect(app.renderer.findByText('Panel A')).toBeUndefined()
    expect(values).toEqual(['c'])
  })

  it('moves focus with the arrow keys and selects with Enter when it does not activate on focus', async () => {
    const app = mount(() => <Example activateOnFocus={false} />)
    const tabs = queryAll('[role="tab"]')
    await focus(app, tabs[0])
    await press(app, 'ArrowRight')
    expect(activeText()).toBe('Tab B')
    expect(selected()).toEqual(['true', 'false', 'false'])
    await press(app, 'Enter')
    expect(selected()).toEqual(['false', 'true', 'false'])
    expect(app.renderer.findByText('Panel B')).toBeDefined()
    await press(app, 'ArrowRight')
    expect(activeText()).toBe('Tab C')
  })

  // The port's TabsTab effect "keeps the highlighted item in sync with the selected tab" tracks the highlighted index, so
  // it snaps the roving index back to the selected tab as soon as focus lands on another one; the next arrow key then
  // starts from the selected tab (Tab A) and wraps to Tab C. Solid semantics, not a Ghia gap: a browser runs the same effect.
  it.fails('moves from the focused tab on an arrow key (port bug: the roving index snaps back)', async () => {
    const app = mount(() => <Example activateOnFocus={false} />)
    await focus(app, queryAll('[role="tab"]')[1])
    await press(app, 'ArrowLeft')
    expect(activeText()).toBe('Tab A')
  })

  it('selects as focus moves with activateOnFocus', async () => {
    const app = mount(() => <Example activateOnFocus />)
    const tabs = queryAll('[role="tab"]')
    await focus(app, tabs[0])
    await press(app, 'ArrowRight')
    expect(selected()).toEqual(['false', 'true', 'false'])
    expect(app.renderer.findByText('Panel B')).toBeDefined()
  })

  it('keeps only the selected tab in the tab order', async () => {
    const app = mount(() => <Example />)
    expect(queryAll('[role="tab"]').map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
    await click(app, queryAll('[role="tab"]')[1])
    expect(queryAll('[role="tab"]').map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  })
})
