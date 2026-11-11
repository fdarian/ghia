/**
 * What code writes to the DOM (`el.id`, `el.style`, `cloneNode`, `popover`) is seen by the stylesheet cascade the way
 * what the framework renders is: the same attribute store, the same own-style path, the same layers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document, getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("code-written DOM and stylesheets in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot({ width: 800, height: 600 })
  })

  afterEach(() => {
    app.unmount()
  })

  function mount(sheet: string, props: Record<string, unknown> = {}): HTMLElement {
    let box: unknown
    app.render(() => (
      <div>
        <style>{sheet}</style>
        <div ref={(element: unknown) => (box = element)} {...props} />
      </div>
    ))
    return box as HTMLElement
  }

  it("matches #id once code sets el.id, and again when it changes", () => {
    const box = mount("#a { opacity: 0.5 } #b { opacity: 0.25 }")
    expect(getComputedStyle(box).opacity).toBe("1")
    box.id = "a"
    app.flushSync(() => {})
    expect(app.renderer.getAttribute((box as unknown as { nativeId: number }).nativeId, "id")).toBe("a")
    expect(getComputedStyle(box).opacity).toBe("0.5")
    box.id = "b"
    app.flushSync(() => {})
    expect(getComputedStyle(box).opacity).toBe("0.25")
  })

  it("applies a <style> element made by code once it is in document.head, and follows its text", () => {
    const box = mount("", { class: "x" })
    const sheet = document.createElement("style")
    sheet.textContent = ".x { opacity: 0.5 }"
    document.head!.appendChild(sheet)
    app.flushSync(() => {})
    expect(getComputedStyle(box).opacity).toBe("0.5")
    sheet.textContent = ".x { opacity: 0.25 }"
    app.flushSync(() => {})
    expect(getComputedStyle(box).opacity).toBe("0.25")
    sheet.remove()
    app.flushSync(() => {})
    expect(getComputedStyle(box).opacity).toBe("1")
  })

  it("matches a [style] selector on a style written from code, and getAttribute reads the same text", () => {
    const box = mount('[style*="--drag"] { padding-top: 7px }', { style: { width: 10 } })
    expect(getComputedStyle(box).paddingTop).toBe("0px")
    box.style.setProperty("--drag", "1")
    app.flushSync(() => {})
    expect(getComputedStyle(box).paddingTop).toBe("7px")
    expect(box.getAttribute("style")).toBe("width: 10px; --drag: 1;")
    box.style.removeProperty("--drag")
    app.flushSync(() => {})
    expect(getComputedStyle(box).paddingTop).toBe("0px")
  })

  it("lets an inline style written from code win over a sheet rule", () => {
    const box = mount(".x { opacity: 0.5 }", { class: "x" })
    expect(getComputedStyle(box).opacity).toBe("0.5")
    box.style.opacity = "0.8"
    app.flushSync(() => {})
    expect(getComputedStyle(box).opacity).toBe("0.8")
  })

  it("copies the class and the data attributes with cloneNode, so a rule matches the clone", () => {
    const box = mount(".card { opacity: 0.5 } [data-k=v] { padding-top: 3px }", { class: "card", "data-k": "v" })
    const copy = box.cloneNode(false) as HTMLElement
    expect(copy.getAttribute("class")).toBe("card")
    document.body.appendChild(copy)
    app.flushSync(() => {})
    expect(getComputedStyle(copy).opacity).toBe("0.5")
    expect(getComputedStyle(copy).paddingTop).toBe("3px")
    copy.remove()
  })

  it("layers the popover user agent style under a sheet rule, and keeps an open popover fixed", () => {
    const box = mount("[popover] { padding-top: 11px; position: relative }", { popover: "manual" })
    box.appendChild(document.createElement("div"))
    expect(getComputedStyle(box).display).toBe("none")
    box.showPopover()
    app.flushSync(() => {})
    expect(getComputedStyle(box).display).not.toBe("none")
    expect(getComputedStyle(box).paddingTop).toBe("11px")
    expect(getComputedStyle(box).position).toBe("fixed")
    box.hidePopover()
    app.flushSync(() => {})
    expect(getComputedStyle(box).display).toBe("none")
  })
})
