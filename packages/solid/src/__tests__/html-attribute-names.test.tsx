import { describe, expect, it } from "vitest"
import { createSignal } from "solid-js"
import { document } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { HostElement } from "../host.js"
import { Dynamic } from "../web.js"

const box = { width: 60, height: 20 }

describe.skipIf(!hasNativeTestRenderer)("Solid JSX written with the HTML attribute names", () => {
  it("focuses an element with autofocus when it mounts, as autoFocus does", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    let field!: HostElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <input ref={field} autofocus style={box} />
      </div>
    ))
    expect(document.activeElement).toBe(field)
    expect(field.getAttribute("autofocus")).toBe("")
    app.unmount()
  })

  it("does not focus on autofocus={false} or autofocus=''", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    let off!: HostElement
    let empty!: HostElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <input ref={off} autofocus={false} style={box} />
        <input ref={empty} autofocus={"" as unknown as boolean} style={box} />
      </div>
    ))
    expect(document.activeElement).not.toBe(off)
    expect(document.activeElement).not.toBe(empty)
    app.unmount()
  })

  it("makes an element focusable with tabindex as a number or a text", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    let number!: HostElement
    let text!: HostElement
    let plain!: HostElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <div ref={number} tabindex={0} style={box} />
        <div ref={text} tabindex="-1" style={box} />
        <div ref={plain} style={box} />
      </div>
    ))
    number.focus()
    expect(document.activeElement).toBe(number)
    text.focus()
    expect(document.activeElement).toBe(text)
    plain.focus()
    expect(document.activeElement).toBe(text)
    expect(number.getAttribute("tabindex")).toBe("0")
    expect(text.getAttribute("tabindex")).toBe("-1")
    expect(plain.getAttribute("tabindex")).toBeNull()
    app.unmount()
  })

  it("follows a tabindex signal and removes it on undefined", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    const [index, setIndex] = createSignal<number | undefined>(0)
    let target!: HostElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <div ref={target} tabindex={index()} style={box} />
      </div>
    ))
    expect(target.getAttribute("tabindex")).toBe("0")
    setIndex(-1)
    expect(target.getAttribute("tabindex")).toBe("-1")
    setIndex(undefined)
    expect(target.getAttribute("tabindex")).toBeNull()
    app.unmount()
  })

  it("reads readonly, maxlength, colspan, rowspan and for back as attributes", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    let input!: HostElement
    let cell!: HostElement
    let label!: HostElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <input ref={input} readonly maxlength={4} style={box} />
        <table>
          <tbody>
            <tr>
              <td ref={cell} colspan={2} rowspan="3" />
            </tr>
          </tbody>
        </table>
        <label ref={label} for="x" />
      </div>
    ))
    expect(input.getAttribute("readonly")).toBe("")
    expect(input.getAttribute("maxlength")).toBe("4")
    expect(cell.getAttribute("colspan")).toBe("2")
    expect(cell.getAttribute("rowspan")).toBe("3")
    expect(label.getAttribute("for")).toBe("x")
    app.unmount()
  })

  it("reaches a spread", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    let spread!: HostElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <input ref={spread} {...{ autofocus: true, tabindex: "0" }} style={box} />
      </div>
    ))
    expect(document.activeElement).toBe(spread)
    expect(spread.getAttribute("tabindex")).toBe("0")
    app.unmount()
  })

  it("reaches a Dynamic element", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    let dynamic!: HostElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <Dynamic component="div" ref={(element: HostElement) => (dynamic = element)} tabindex={0} style={box} />
      </div>
    ))
    expect(dynamic.getAttribute("tabindex")).toBe("0")
    dynamic.focus()
    expect(document.activeElement).toBe(dynamic)
    app.unmount()
  })
})
