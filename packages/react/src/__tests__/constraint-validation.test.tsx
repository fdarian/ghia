/** `required`, `name`, `form`, `willValidate`, `validity`, `validationMessage`, `setCustomValidity` and `checkValidity` of an `<input>`. */
// @ts-nocheck

import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("constraint validation", () => {
  function mount(ui) {
    const root = createTestRoot()
    root.render(ui)
    return root
  }

  it("reads a required text control with no text as valueMissing, and valid once it has text", () => {
    let input
    const root = mount(<input ref={(el) => (input = el ?? input)} required name="email" defaultValue="" style={{ width: 100, height: 20 }} />)
    expect(input.required).toBe(true)
    expect(input.name).toBe("email")
    expect(input.willValidate).toBe(true)
    expect(input.validity.valueMissing).toBe(true)
    expect(input.validity.valid).toBe(false)
    expect(input.validationMessage).toBe("Please fill out this field.")
    expect(input.checkValidity()).toBe(false)
    root.unmount()

    let filled
    const second = mount(<input ref={(el) => (filled = el ?? filled)} required defaultValue="a@b" style={{ width: 100, height: 20 }} />)
    expect(filled.validity.valid).toBe(true)
    expect(filled.validationMessage).toBe("")
    expect(filled.checkValidity()).toBe(true)
    second.unmount()
  })

  it("is not validated while disabled, read-only or of a type that holds no value", () => {
    const controls = {}
    const root = mount(
      <div style={{ width: 300, height: 200 }}>
        <input ref={(el) => (controls.disabled = el ?? controls.disabled)} required disabled style={{ width: 100, height: 20 }} />
        <input ref={(el) => (controls.readonly = el ?? controls.readonly)} required readOnly style={{ width: 100, height: 20 }} />
        <input ref={(el) => (controls.hidden = el ?? controls.hidden)} required type="hidden" />
      </div>
    )
    for (const control of Object.values(controls)) {
      expect(control.willValidate).toBe(false)
      expect(control.validity.valueMissing).toBe(false)
      expect(control.checkValidity()).toBe(true)
    }
    root.unmount()
  })

  it("needs a required checkbox checked and a required radio group to have one checked", () => {
    const controls = {}
    const root = mount(
      <div style={{ width: 300, height: 200 }}>
        <input ref={(el) => (controls.box = el ?? controls.box)} type="checkbox" required style={{ width: 20, height: 20 }} />
        <input ref={(el) => (controls.a = el ?? controls.a)} type="radio" name="size" required style={{ width: 20, height: 20 }} />
        <input ref={(el) => (controls.b = el ?? controls.b)} type="radio" name="size" style={{ width: 20, height: 20 }} />
      </div>
    )
    expect(controls.box.validity.valueMissing).toBe(true)
    expect(controls.box.validationMessage).toBe("Please check this box if you want to proceed.")
    expect(controls.a.validity.valueMissing).toBe(true)
    expect(controls.a.validationMessage).toBe("Please select one of these options.")
    controls.box.checked = true
    controls.b.checked = true
    expect(controls.box.validity.valid).toBe(true)
    expect(controls.a.validity.valid).toBe(true)
    root.unmount()
  })

  it("holds a custom message that makes it invalid until it is cleared, and reports it with a cancelable invalid event", () => {
    let input
    const root = mount(<input ref={(el) => (input = el ?? input)} defaultValue="x" style={{ width: 100, height: 20 }} />)
    const events = []
    input.addEventListener("invalid", (event) => {
      events.push([event.type, event.cancelable, event.bubbles])
    })
    expect(input.validity.valid).toBe(true)
    expect(input.checkValidity()).toBe(true)
    expect(events).toEqual([])

    input.setCustomValidity("Too common")
    expect(input.validity.customError).toBe(true)
    expect(input.validity.valid).toBe(false)
    expect(input.validationMessage).toBe("Too common")
    expect(input.checkValidity()).toBe(false)
    expect(input.reportValidity()).toBe(false)
    expect(events).toEqual([["invalid", true, false], ["invalid", true, false]])

    input.setCustomValidity("")
    expect(input.validity.valid).toBe(true)
    root.unmount()
  })

  it("reads the form it is in, and null outside one", () => {
    const controls = {}
    const root = mount(
      <div style={{ width: 300, height: 200 }}>
        <form ref={(el) => (controls.form = el ?? controls.form)} style={{ width: 200, height: 40 }}>
          <input ref={(el) => (controls.inside = el ?? controls.inside)} style={{ width: 100, height: 20 }} />
        </form>
        <input ref={(el) => (controls.outside = el ?? controls.outside)} style={{ width: 100, height: 20 }} />
      </div>
    )
    expect(controls.inside.form).toBe(controls.form)
    expect(controls.outside.form).toBeNull()
    expect(controls.form.name).toBe("")
    root.unmount()
  })

  it("is only on the controls: a div has none of it", () => {
    let box
    const root = mount(<div ref={(el) => (box = el ?? box)} style={{ width: 10, height: 10 }} />)
    expect(box.validity).toBeUndefined()
    expect(box.willValidate).toBeUndefined()
    expect(box.checkValidity).toBeUndefined()
    root.unmount()
  })
})
