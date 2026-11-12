import { describe, expect, it } from "vitest"
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

  it("is not on a div", () => {
    let box!: HostElement
    const app = createTestRoot()
    app.render(() => <div ref={box} style={{ width: 10, height: 10 }} />)
    expect((box as unknown as { validity?: unknown }).validity).toBeUndefined()
    expect((box as unknown as { checkValidity?: unknown }).checkValidity).toBeUndefined()
    app.unmount()
  })
})
