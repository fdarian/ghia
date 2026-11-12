import { describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { HostElement } from "../host.js"

describe.skipIf(!hasNativeTestRenderer)("Solid constraint validation", () => {
  it("reads valueMissing and a custom message of a required input", () => {
    let input!: HostElement
    const app = createTestRoot()
    app.render(() => <input ref={input} required name="email" value="" style={{ width: 100, height: 20 }} />)
    const control = input as unknown as HTMLInputElement
    expect(control.required).toBe(true)
    expect(control.name).toBe("email")
    expect(control.willValidate).toBe(true)
    expect(control.validity.valueMissing).toBe(true)
    expect(control.validationMessage).toBe("Please fill out this field.")
    expect(control.checkValidity()).toBe(false)
    control.setCustomValidity("Taken")
    expect(control.validationMessage).toBe("Taken")
    expect(control.validity.customError).toBe(true)
    app.unmount()
  })

  it("makes every radio of a group missing while none is checked when any of them is required", () => {
    const radios = {} as Record<string, HostElement>
    const app = createTestRoot()
    app.render(() => (
      <div style={{ width: 400, height: 200 }}>
        <form style={{ width: 300, height: 100 }}>
          <input ref={(el) => (radios.a = el)} type="radio" name="g" style={{ width: 20, height: 20 }} />
          <input ref={(el) => (radios.b = el)} type="radio" name="g" required style={{ width: 20, height: 20 }} />
          <input ref={(el) => (radios.alone = el)} type="radio" style={{ width: 20, height: 20 }} />
        </form>
        <input ref={(el) => (radios.outside = el)} type="radio" name="g" style={{ width: 20, height: 20 }} />
      </div>
    ))
    const validity = (name: string) => (radios[name] as unknown as HTMLInputElement).validity
    expect(validity("a").valueMissing).toBe(true)
    expect(validity("b").valueMissing).toBe(true)
    expect((radios.a as unknown as HTMLInputElement).validationMessage).toBe("Please select one of these options.")
    expect(validity("alone").valueMissing).toBe(false)
    expect(validity("outside").valueMissing).toBe(false)
    ;(radios.a as unknown as HTMLInputElement).checked = true
    expect(validity("a").valid).toBe(true)
    expect(validity("b").valid).toBe(true)
    app.unmount()
  })

  it("follows the form attribute for the form owner and for radio groups", () => {
    const controls = {} as Record<string, HostElement>
    const app = createTestRoot()
    app.render(() => (
      <div style={{ width: 400, height: 300 }}>
        <form id="f" ref={(el) => (controls.form = el)} style={{ width: 200, height: 40 }}>
          <input ref={(el) => (controls.member = el)} type="radio" name="g" required style={{ width: 20, height: 20 }} />
        </form>
        <input ref={(el) => (controls.elsewhere = el)} form="f" type="radio" name="g" style={{ width: 20, height: 20 }} />
        <input ref={(el) => (controls.free = el)} type="radio" name="g" style={{ width: 20, height: 20 }} />
        <input ref={(el) => (controls.unknown = el)} form="missing" style={{ width: 20, height: 20 }} />
        <input ref={(el) => (controls.notForm = el)} form="plain" style={{ width: 20, height: 20 }} />
        <div id="plain" />
      </div>
    ))
    const input = (name: string) => controls[name] as unknown as HTMLInputElement
    expect(input("elsewhere").form).toBe(controls.form)
    expect(input("unknown").form).toBeNull()
    expect(input("notForm").form).toBeNull()
    expect(input("elsewhere").validity.valueMissing).toBe(true)
    expect(input("free").validity.valueMissing).toBe(false)
    input("elsewhere").checked = true
    expect(input("member").validity.valid).toBe(true)
    app.unmount()
  })

  it("lets reportValidity() fire invalid and focus the control unless a listener canceled it", () => {
    let field!: HostElement
    const app = createTestRoot()
    app.render(() => <input ref={field} required value="" style={{ width: 100, height: 20 }} />)
    const input = field as unknown as HTMLInputElement
    const seen: string[] = []
    let cancel = true
    input.addEventListener("invalid", (event) => {
      seen.push(event.type)
      if (cancel) event.preventDefault()
    })
    expect(input.reportValidity()).toBe(false)
    expect(seen).toEqual(["invalid"])
    expect(document.activeElement).not.toBe(field)

    cancel = false
    expect(input.reportValidity()).toBe(false)
    expect(seen).toEqual(["invalid", "invalid"])
    expect(document.activeElement).toBe(field)
    app.unmount()
  })

  it("lists the ValidityState attributes in a for-in, as WebIDL attributes are", () => {
    let field!: HostElement
    const app = createTestRoot()
    app.render(() => <input ref={field} style={{ width: 100, height: 20 }} />)
    const keys: string[] = []
    for (const key in (field as unknown as HTMLInputElement).validity) keys.push(key)
    expect(keys).toEqual([
      "valueMissing", "typeMismatch", "patternMismatch", "tooLong", "tooShort", "rangeUnderflow",
      "rangeOverflow", "stepMismatch", "badInput", "customError", "valid",
    ])
    app.unmount()
  })

  it("is not on a div", () => {
    let box!: HostElement
    const app = createTestRoot()
    app.render(() => <div ref={box} style={{ width: 10, height: 10 }} />)
    expect((box as unknown as { validity?: unknown }).validity).toBeUndefined()
    expect((box as unknown as { checkValidity?: unknown }).checkValidity).toBeUndefined()
    app.unmount()
  })
})
