// hidden, tabIndex, isContentEditable, shadowRoot and assignedSlot on host elements, and the user agent
// style `[hidden]` gives: display: none under the author's own style.
import { describe, expect, it } from "vitest"
import type { PublicInstance } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("the hidden attribute", () => {
  it("is display: none for any element, and leaves it when the prop goes", () => {
    let box: PublicInstance | null = null
    const root = createTestRoot()
    const view = (hidden: boolean | undefined) => (
      <div style={{ width: 100, height: 100 }}>
        <div ref={(element) => { box = element }} hidden={hidden} style={{ width: 40, height: 40 }} />
      </div>
    )
    try {
      root.render(view(true))
      expect(box!.hidden).toBe(true)
      expect(box!.getAttribute("hidden")).toBe("")
      expect(getComputedStyle(box!).display).toBe("none")
      expect(box!.getClientRects().length).toBe(0)
      expect(box!.offsetWidth).toBe(0)
      expect(box!.offsetParent).toBeNull()
      root.render(view(false))
      expect(box!.hidden).toBe(false)
      expect(getComputedStyle(box!).display).toBe("block")
      expect(box!.offsetWidth).toBe(40)
      expect(box!.offsetParent).toBe(document.body)
      root.render(view(true))
      expect(box!.offsetWidth).toBe(0)
      root.render(view(undefined))
      expect(box!.offsetWidth).toBe(40)
    } finally {
      root.unmount()
    }
  })

  it("is written by the property and by setAttribute, and read back", () => {
    let box: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div style={{ width: 100, height: 100 }}>
        <div ref={(element) => { box = element }} style={{ width: 40, height: 40 }} />
      </div>
    )
    try {
      expect(box!.offsetWidth).toBe(40)
      box!.hidden = true
      expect(getComputedStyle(box!).display).toBe("none")
      expect(box!.offsetWidth).toBe(0)
      box!.hidden = false
      expect(box!.offsetWidth).toBe(40)
      box!.setAttribute("hidden", "")
      expect(box!.offsetWidth).toBe(0)
      box!.removeAttribute("hidden")
      expect(box!.offsetWidth).toBe(40)
    } finally {
      root.unmount()
    }
  })

  it("is under the author's display, as the user agent style is", () => {
    let box: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div style={{ width: 100, height: 100 }}>
        <div ref={(element) => { box = element }} hidden style={{ display: "block", width: 40, height: 40 }} />
      </div>
    )
    try {
      expect(box!.hidden).toBe(true)
      expect(box!.offsetWidth).toBe(40)
    } finally {
      root.unmount()
    }
  })

  it("keeps the rest of the tag's style under it, and leaves a box for until-found", () => {
    let heading: PublicInstance | null = null
    let found: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div style={{ width: 200, height: 200 }}>
        <h1 ref={(element) => { heading = element }} hidden style={{ display: "block", height: 20 }}>t</h1>
        <div ref={(element) => { found = element }} hidden="until-found" style={{ width: 30, height: 30 }} />
      </div>
    )
    try {
      expect(parseFloat(getComputedStyle(heading!).marginTop), "an h1's margin is still there").toBeGreaterThan(0)
      expect(found!.hidden).toBe("until-found")
      expect(found!.offsetWidth).toBe(30)
    } finally {
      root.unmount()
    }
  })

  it("hides a subtree: nothing in it has a box", () => {
    let inner: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div hidden>
        <div ref={(element) => { inner = element }} style={{ width: 10, height: 10 }} />
      </div>
    )
    try {
      expect(inner!.offsetWidth).toBe(0)
      expect(inner!.getClientRects().length).toBe(0)
    } finally {
      root.unmount()
    }
  })
})

describeNative("tabIndex", () => {
  it("is the prop, else the default of the tag", () => {
    const seen: Record<string, PublicInstance | null> = {}
    const root = createTestRoot()
    root.render(
      <div>
        <div ref={(element) => { seen.plain = element }} />
        <div ref={(element) => { seen.zero = element }} tabIndex={0} />
        <div ref={(element) => { seen.negative = element }} tabIndex={-1} />
        <button ref={(element) => { seen.button = element }} />
        <button ref={(element) => { seen.buttonOff = element }} tabIndex={-1} />
        <a ref={(element) => { seen.anchor = element }} />
        <details>
          <summary ref={(element) => { seen.summary = element }}>a</summary>
          <summary ref={(element) => { seen.second = element }}>b</summary>
        </details>
      </div>
    )
    try {
      expect(seen.plain!.tabIndex).toBe(-1)
      expect(seen.zero!.tabIndex).toBe(0)
      expect(seen.negative!.tabIndex).toBe(-1)
      expect(seen.button!.tabIndex).toBe(0)
      expect(seen.buttonOff!.tabIndex).toBe(-1)
      expect(seen.anchor!.tabIndex).toBe(0)
      expect(seen.summary!.tabIndex, "the first summary of a details").toBe(0)
      expect(seen.second!.tabIndex, "not the second").toBe(-1)
    } finally {
      root.unmount()
    }
  })

  it("is written through to native, which then takes focus on it", () => {
    let box: PublicInstance | null = null
    const root = createTestRoot()
    root.render(<div ref={(element) => { box = element }} style={{ width: 20, height: 20 }} />)
    try {
      box!.tabIndex = 0
      expect(box!.getAttribute("tabindex")).toBe("0")
      box!.focus()
      expect(document.activeElement).toBe(box)
      box!.tabIndex = -1
      expect(box!.tabIndex).toBe(-1)
    } finally {
      root.unmount()
    }
  })
})

describeNative("the members with a fixed answer", () => {
  it("are on every host element, an svg shape too", () => {
    let box: PublicInstance | null = null
    let shape: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div ref={(element) => { box = element }} contentEditable>
        <svg width={10} height={10}>
          <rect ref={(element) => { shape = element }} width={5} height={5} />
        </svg>
      </div>
    )
    try {
      for (const element of [box!, shape!]) {
        expect(element.isContentEditable).toBe(false)
        expect(element.shadowRoot).toBeNull()
        expect(element.assignedSlot).toBeNull()
      }
      expect(shape!.tabIndex).toBe(-1)
    } finally {
      root.unmount()
    }
  })
})
