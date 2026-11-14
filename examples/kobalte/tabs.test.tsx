import { describe, expect, it } from 'vitest'
import { Tabs } from '@kobalte/core/tabs'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { activeText, box, byText, click, focus, isShown, mount, press, query, queryAll } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const TRIGGER = { display: 'block', width: 90, height: 28 } as const

function Example(props: { onChange?: (value: string) => void; activationMode?: 'automatic' | 'manual' }) {
  return (
    <div style={{ position: 'absolute', top: 40, left: 40, width: 500, height: 300 }}>
      <Tabs defaultValue="account" onChange={props.onChange} activationMode={props.activationMode}>
        <Tabs.List aria-label="Settings" style={{ display: 'flex', flexDirection: 'row', width: 400, height: 28 }}>
          <Tabs.Trigger value="account" style={TRIGGER}>
            Account
          </Tabs.Trigger>
          <Tabs.Trigger value="password" style={TRIGGER}>
            Password
          </Tabs.Trigger>
          <Tabs.Trigger value="billing" disabled style={TRIGGER}>
            Billing
          </Tabs.Trigger>
          <Tabs.Trigger value="team" style={TRIGGER}>
            Team
          </Tabs.Trigger>
          <Tabs.Indicator data-testid="indicator" style={{ position: 'absolute', height: 2 }} />
        </Tabs.List>
        <Tabs.Content value="account" style={{ display: 'block', width: 300, height: 40 }}>
          Account panel
        </Tabs.Content>
        <Tabs.Content value="password" style={{ display: 'block', width: 300, height: 40 }}>
          Password panel
        </Tabs.Content>
        <Tabs.Content value="team" style={{ display: 'block', width: 300, height: 40 }}>
          Team panel
        </Tabs.Content>
      </Tabs>
    </div>
  )
}

function tab(name: string): HTMLElement {
  return byText(name, '[role="tab"]')
}

function selected(): string[] {
  return queryAll('[role="tab"]')
    .filter((element) => element.getAttribute('aria-selected') === 'true')
    .map((element) => element.textContent ?? '')
}

function panels(): string[] {
  return queryAll('[role="tabpanel"]').map((element) => element.textContent ?? '')
}

describeNative('Kobalte Tabs', () => {
  it('renders a tablist with the default tab selected and only its panel', () => {
    mount(() => <Example />)
    expect(query('[role="tablist"]').getAttribute('aria-orientation')).toBe('horizontal')
    expect(queryAll('[role="tab"]').map((element) => element.textContent)).toEqual(['Account', 'Password', 'Billing', 'Team'])
    expect(selected()).toEqual(['Account'])
    expect(tab('Account').hasAttribute('data-selected')).toBe(true)
    expect(tab('Password').hasAttribute('data-selected')).toBe(false)
    expect(tab('Account').getAttribute('tabindex')).toBe('0')
    expect(tab('Password').getAttribute('tabindex')).toBe('-1')
    expect(panels()).toEqual(['Account panel'])
    expect(tab('Account').getAttribute('aria-controls')).toBe(query('[role="tabpanel"]').id)
    expect(query('[role="tabpanel"]').getAttribute('aria-labelledby')).toBe(tab('Account').id)
  })

  it('selects a tab on a click and swaps the panel', async () => {
    const values: string[] = []
    const app = mount(() => <Example onChange={(value) => values.push(value)} />)
    await click(app, tab('Password'))
    expect(selected()).toEqual(['Password'])
    expect(panels()).toEqual(['Password panel'])
    expect(values).toEqual(['password'])
    expect(document.activeElement).toBe(tab('Password'))
    expect(isShown('[role="tabpanel"]')).toBe(true)
  })

  it('moves focus and selection with the arrow keys, skipping the disabled tab', async () => {
    const values: string[] = []
    const app = mount(() => <Example onChange={(value) => values.push(value)} />)
    await focus(app, tab('Account'))
    await press(app, 'ArrowRight')
    expect(document.activeElement, activeText()).toBe(tab('Password'))
    expect(selected()).toEqual(['Password'])

    await press(app, 'ArrowRight')
    expect(document.activeElement, activeText()).toBe(tab('Team'))
    expect(selected()).toEqual(['Team'])
    expect(panels()).toEqual(['Team panel'])

    await press(app, 'ArrowRight')
    expect(document.activeElement, activeText()).toBe(tab('Account'))
    await press(app, 'ArrowLeft')
    expect(document.activeElement, activeText()).toBe(tab('Team'))
    expect(values).toEqual(['password', 'team', 'account', 'team'])
  })

  it('jumps to the first and last tab with Home and End', async () => {
    const app = mount(() => <Example />)
    await focus(app, tab('Password'))
    await press(app, 'End')
    expect(document.activeElement, activeText()).toBe(tab('Team'))
    await press(app, 'Home')
    expect(document.activeElement, activeText()).toBe(tab('Account'))
  })

  it('does not select a disabled tab on a click', async () => {
    const app = mount(() => <Example />)
    expect(tab('Billing').hasAttribute('data-disabled')).toBe(true)
    await click(app, tab('Billing'))
    expect(selected()).toEqual(['Account'])
  })

  it('moves focus without selecting in manual activation, and selects on Enter', async () => {
    const app = mount(() => <Example activationMode="manual" />)
    await focus(app, tab('Account'))
    await press(app, 'ArrowRight')
    expect(document.activeElement, activeText()).toBe(tab('Password'))
    expect(selected()).toEqual(['Account'])
    await press(app, 'Enter')
    expect(selected()).toEqual(['Password'])
    expect(panels()).toEqual(['Password panel'])
  })

  it('puts the indicator under the selected tab', async () => {
    const app = mount(() => <Example />)
    await click(app, tab('Team'))
    const indicator = box(query('[data-testid="indicator"]'))
    const selectedBox = box(tab('Team'))
    expect(indicator.x).toBeCloseTo(selectedBox.x, 0)
    expect(indicator.width).toBeCloseTo(selectedBox.width, 0)
  })
})
