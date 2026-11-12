import { describe, expect, it } from 'vitest'
import { Field } from '@base-ui/react/field'
import { hasNativeTestRenderer } from '@ghia/react/testing'
import { byText, click, exists, focus, mount, press, query } from './harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example(props: { mode: 'onBlur' | 'onChange' }) {
  return (
    <Field.Root
      name="email"
      validationMode={props.mode}
      validate={(value) => (String(value).includes('@') ? null : 'Enter a valid email')}
    >
      <Field.Label style={{ display: 'block', height: 20 }}>Email</Field.Label>
      <Field.Control required style={{ display: 'block', width: 200, height: 24 }} />
      <Field.Description style={{ display: 'block', height: 20 }}>We never share it</Field.Description>
      <Field.Error style={{ display: 'block', height: 20 }} />
      <button type="button" style={{ display: 'block', width: 60, height: 20 }}>
        Next
      </button>
    </Field.Root>
  )
}

function input(): HTMLInputElement {
  return query('input') as HTMLInputElement
}

describeNative('Base UI Field', () => {
  it('labels and describes its control', () => {
    mount(<Example mode="onBlur" />)
    const label = byText('Email', 'label')
    expect(label.getAttribute('for') ?? label.getAttribute('id')).not.toBeNull()
    expect(input().getAttribute('aria-describedby')).toBe(byText('We never share it').id)
    expect(input().required).toBe(true)
  })

  it('focuses the control from a click on its label', async () => {
    const app = mount(<Example mode="onBlur" />)
    await click(app, byText('Email', 'label'))
    expect(document.activeElement).toBe(input())
  })

  it('shows the validation message after the control loses focus with an invalid value', async () => {
    const app = mount(<Example mode="onBlur" />)
    expect(exists('[data-invalid]')).toBe(false)
    await focus(app, input())
    await press(app, 'a b c')
    expect(app.renderer.findByText('Enter a valid email')).toBeUndefined()

    await press(app, 'Tab')
    expect(app.renderer.findByText('Enter a valid email')).toBeDefined()
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(input().hasAttribute('data-invalid')).toBe(true)
    expect(input().hasAttribute('data-touched')).toBe(true)
  })

  it('clears the message when a valid value is committed', async () => {
    const app = mount(<Example mode="onBlur" />)
    await focus(app, input())
    await press(app, 'a')
    await press(app, 'Tab')
    expect(app.renderer.findByText('Enter a valid email')).toBeDefined()
    await focus(app, input())
    await press(app, '@ b')
    await press(app, 'Tab')
    expect(app.renderer.findByText('Enter a valid email')).toBeUndefined()
    expect(input().getAttribute('aria-invalid')).not.toBe('true')
    expect(input().hasAttribute('data-valid')).toBe(true)
  })

  it('validates on every change with validationMode onChange', async () => {
    const app = mount(<Example mode="onChange" />)
    await focus(app, input())
    await press(app, 'a')
    expect(app.renderer.findByText('Enter a valid email')).toBeDefined()
    await press(app, '@')
    expect(app.renderer.findByText('Enter a valid email')).toBeUndefined()
  })

  it('reports a missing required value from the constraint, through match', async () => {
    const app = mount(
      <Field.Root validationMode="onBlur">
        <Field.Control required style={{ display: 'block', width: 200, height: 24 }} />
        <Field.Error match="valueMissing" style={{ display: 'block', height: 20 }}>
          Please enter a value
        </Field.Error>
        <button type="button" style={{ display: 'block', width: 60, height: 20 }}>
          Next
        </button>
      </Field.Root>,
    )
    // Base UI reports a missing value only once the user has changed the field.
    await focus(app, input())
    await press(app, 'Tab')
    expect(app.renderer.findByText('Please enter a value')).toBeUndefined()
    await focus(app, input())
    await press(app, 'x')
    await press(app, 'Backspace')
    await press(app, 'Tab')
    expect(app.renderer.findByText('Please enter a value')).toBeDefined()
    await focus(app, input())
    await press(app, 'x')
    await press(app, 'Tab')
    expect(app.renderer.findByText('Please enter a value')).toBeUndefined()
  })
})
