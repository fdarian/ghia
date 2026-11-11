/**
 * What code writes to the DOM (`el.id`, `el.style`, `cloneNode`, `popover`) is seen by the stylesheet cascade the way
 * what React renders is: the same attribute store, the same own-style path, the same layers.
 */
import React from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document, getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("code-written DOM and stylesheets in React", () => {
  let app: TestRoot

  beforeEach(() => {
    app = createTestRoot({ width: 800, height: 600 })
  })

  afterEach(() => {
    app.unmount()
  })

  async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    app.renderer.flush()
  }

  function tree(sheet: string | null, ref: (element: unknown) => void, props: Record<string, unknown>) {
    return (
      <div>
        {sheet === null ? null : <style>{sheet}</style>}
        <div ref={ref} {...props} />
      </div>
    )
  }

  function mount(sheet: string | null, props: Record<string, unknown> = {}): HTMLElement {
    let box: unknown
    app.render(tree(sheet, (element) => (box = element ?? box), props))
    return box as HTMLElement
  }

  it("matches #id once code sets el.id, and again when it changes", async () => {
    const box = mount("#a { opacity: 0.5 } #b { opacity: 0.25 }")
    box.id = "a"
    await settle()
    expect(app.renderer.getAttribute((box as unknown as { nativeId: number }).nativeId, "id")).toBe("a")
    expect(getComputedStyle(box).opacity).toBe("0.5")
    box.id = "b"
    await settle()
    expect(getComputedStyle(box).opacity).toBe("0.25")
  })

  it("sends an id code set before any sheet existed when the first sheet arrives", async () => {
    let box: unknown
    const ref = (element: unknown) => (box = element ?? box)
    app.render(tree(null, ref, {}))
    const element = box as HTMLElement
    element.id = "a"
    await settle()
    app.render(tree("#a { opacity: 0.5 }", ref, {}))
    await settle()
    expect(getComputedStyle(element).opacity).toBe("0.5")
  })

  it("applies a <style> element made by code once it is in document.head, and follows its text", async () => {
    const box = mount(null, { class: "x" })
    const sheet = document.createElement("style")
    sheet.textContent = ".x { opacity: 0.5 }"
    document.head!.appendChild(sheet)
    await settle()
    expect(getComputedStyle(box).opacity).toBe("0.5")
    sheet.textContent = ".x { opacity: 0.25 }"
    await settle()
    expect(getComputedStyle(box).opacity).toBe("0.25")
    sheet.remove()
    await settle()
    expect(getComputedStyle(box).opacity).toBe("1")
  })

  it("matches a [style] selector on a style written from code, and getAttribute reads the same text", async () => {
    const box = mount('[style*="--drag"] { padding-top: 7px }', { style: { width: 10 } })
    expect(getComputedStyle(box).paddingTop).toBe("0px")
    box.style.setProperty("--drag", "1")
    await settle()
    expect(getComputedStyle(box).paddingTop).toBe("7px")
    expect(box.getAttribute("style")).toBe("width: 10px; --drag: 1;")
    box.style.removeProperty("--drag")
    await settle()
    expect(getComputedStyle(box).paddingTop).toBe("0px")
  })

  it("writes a number rotate to the [style] text as degrees, so a [style*=45deg] rule matches", async () => {
    const box = mount('[style*="45deg"] { padding-top: 5px }', { style: { rotate: 45 } })
    await settle()
    expect(box.getAttribute("style")).toBe("rotate: 45deg;")
    expect(getComputedStyle(box).paddingTop).toBe("5px")
  })

  it("copies the class and the data attributes with cloneNode, so a rule matches the clone", async () => {
    const box = mount(".card { opacity: 0.5 } [data-k=v] { padding-top: 3px }", { className: "card", "data-k": "v" })
    const copy = box.cloneNode(false) as HTMLElement
    expect(copy.getAttribute("class")).toBe("card")
    document.body.appendChild(copy)
    await settle()
    expect(getComputedStyle(copy).opacity).toBe("0.5")
    expect(getComputedStyle(copy).paddingTop).toBe("3px")
    copy.remove()
  })

  it("layers the popover user agent style under a sheet rule, and keeps an open popover fixed", async () => {
    const box = mount("[popover] { padding-top: 11px; position: relative }", { popover: "manual" })
    expect(getComputedStyle(box).display).toBe("none")
    box.showPopover()
    await settle()
    expect(getComputedStyle(box).display).not.toBe("none")
    expect(getComputedStyle(box).paddingTop).toBe("11px")
    expect(getComputedStyle(box).position).toBe("fixed")
    box.hidePopover()
    await settle()
    expect(getComputedStyle(box).display).toBe("none")
  })
})
