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

  it("does not focus on autofocus={false}, and takes a string as present, as a template does", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    let off!: HostElement
    let empty!: HostElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <input ref={off} autofocus={false} style={box} />
        <input ref={empty} autofocus={"" as unknown as boolean} style={box} />
      </div>
    ))
    expect(document.activeElement).toBe(empty)
    expect(off.getAttribute("autofocus")).toBeNull()
    expect(empty.getAttribute("autofocus")).toBe("")
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

  it("makes an element focusable with tabIndex given as a text", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    let target!: HostElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <div ref={target} {...{ tabIndex: "-1" }} style={box} />
      </div>
    ))
    target.focus()
    expect(document.activeElement).toBe(target)
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
    target.focus()
    expect(document.activeElement).not.toBe(target)
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

  it("keeps tabindex and autofocus lowercase on an svg element, as Chrome does", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    let svg!: HostElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <svg ref={svg as never} tabindex="0" style={box} />
      </div>
    ))
    expect(svg.getAttribute("tabindex")).toBe("0")
    expect(svg.getAttributeNames()).toContain("tabindex")
    expect(svg.getAttributeNames()).not.toContain("tabIndex")
    expect(svg.tabIndex).toBe(0)
    svg.focus()
    expect(document.activeElement).toBe(svg)
    app.unmount()
  })

  it("ignores typing in a readonly input and stops it at maxlength", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    const keys = (testId: string, text: string) => app.renderer.nativeSimulateKeystrokes(app.renderer.findByTestId(testId)!.id, text)
    let readonly!: HTMLInputElement
    let limited!: HTMLInputElement
    app.render(() => (
      <div style={{ width: 200, height: 100 }}>
        <input ref={readonly as never} testId="readonly" readonly value="ab" style={box} />
        <input ref={limited as never} testId="limited" maxlength={3} style={box} />
      </div>
    ))
    keys("readonly", "x y")
    expect(readonly.value).toBe("ab")
    keys("limited", "a b c d e")
    expect(limited.value).toBe("abc")
    app.unmount()
  })

  it("spans a td over two columns with colspan", () => {
    const app = createTestRoot({ width: 300, height: 200 })
    let wide!: HostElement
    let left!: HostElement
    let right!: HostElement
    app.render(() => (
      <div style={{ width: 300, height: 200 }}>
        <table style={{ borderSpacing: 0 }}>
          <tbody>
            <tr>
              <td ref={wide} colspan={2} style={{ padding: 0 }}>
                <div style={{ width: 60, height: 10 }} />
              </td>
            </tr>
            <tr>
              <td ref={left} style={{ padding: 0 }}>
                <div style={{ width: 40, height: 10 }} />
              </td>
              <td ref={right} style={{ padding: 0 }}>
                <div style={{ width: 50, height: 10 }} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    ))
    const rect = (element: HostElement) => element.getBoundingClientRect()
    expect(rect(left).width).toBe(40)
    expect(rect(right).width).toBe(50)
    expect(rect(wide).width).toBe(90)
    expect(rect(wide).left).toBe(rect(left).left)
    expect(rect(wide).right).toBe(rect(right).right)
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
