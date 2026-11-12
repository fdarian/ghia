/** What a Suspense boundary does to the elements it hides goes through their live style, as it does in React DOM. */
import { Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("elements Suspense hides", () => {
  let app: TestRoot

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    app.unmount()
  })

  const pending = new Promise<never>(() => {})
  function Maybe(props: { suspend: boolean }) {
    if (props.suspend) throw pending
    return null
  }

  function render(refs: Record<string, any>, suspend: boolean, display?: string) {
    app.render(
      <div ref={(element: unknown) => (refs.parent ??= element)}>
        <Suspense fallback={<span>fallback</span>}>
          <div
            ref={(element: unknown) => {
              // React clears the ref while it hides the element.
              refs.box ??= element
            }}
            style={{ width: 40, height: 20, ...(display === undefined ? {} : { display }) }}
          />
          shown
          <Maybe suspend={suspend} />
        </Suspense>
      </div>
    )
  }

  it("reads display none with priority important while hidden, and the style attribute has it", () => {
    const refs: Record<string, any> = {}
    render(refs, false)
    expect(refs.box.getAttribute("style")).toBe("width: 40px; height: 20px;")
    render(refs, true)
    expect([refs.box.style.display, refs.box.style.getPropertyPriority("display")]).toEqual(["none", "important"])
    expect(refs.box.getAttribute("style")).toBe("width: 40px; height: 20px; display: none !important;")
    expect(getComputedStyle(refs.box).display).toBe("none")

    render(refs, false)
    expect(refs.box.style.display).toBe("")
    expect(refs.box.getAttribute("style")).toBe("width: 40px; height: 20px;")
    expect(getComputedStyle(refs.box).display).toBe("block")
  })

  it("unhides to the display the props give", () => {
    const refs: Record<string, any> = {}
    render(refs, false, "flex")
    render(refs, true, "flex")
    expect(getComputedStyle(refs.box).display).toBe("none")
    render(refs, false, "flex")
    expect([refs.box.style.display, getComputedStyle(refs.box).display]).toEqual(["flex", "flex"])
  })

  it("drops a display that code wrote while the element was hidden", () => {
    const refs: Record<string, any> = {}
    render(refs, false)
    render(refs, true)
    refs.box.style.display = "grid"
    render(refs, false)
    expect([refs.box.style.display, getComputedStyle(refs.box).display]).toEqual(["", "block"])
  })

  it("records the hide and the unhide as attribute mutations of style", () => {
    const refs: Record<string, any> = {}
    render(refs, false)
    const observer = new MutationObserver(() => {})
    observer.observe(refs.box, { attributes: true, attributeOldValue: true })
    try {
      render(refs, true)
      render(refs, false)
      expect(observer.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
        ["style", "width: 40px; height: 20px;"],
        ["style", "width: 40px; height: 20px; display: none !important;"],
      ])
    } finally {
      observer.disconnect()
    }
  })

  it("empties a text node while it is hidden and gives it back", () => {
    const refs: Record<string, any> = {}
    render(refs, false)
    const text = refs.parent.childNodes[1]
    expect(text.nodeValue).toBe("shown")
    render(refs, true)
    expect(text.nodeValue).toBe("")
    render(refs, false)
    expect(text.nodeValue).toBe("shown")
  })
})
