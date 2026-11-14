/**
 * `getElementsByTagName`, `getElementsByClassName` and `getElementsByName` on elements and on
 * `document`, the live lists they return, and the `className` setter, in React.
 */
import type { ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("live element lists and className, in React", () => {
  let app: ReturnType<typeof createTestRoot> | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
  })

  function mount(tree: (grab: (name: string) => (instance: unknown) => void) => ReactNode): Record<string, HTMLElement> {
    app = createTestRoot({ width: 400, height: 300 })
    const found: Record<string, HTMLElement> = {}
    const grab = (name: string) => (instance: unknown) => {
      if (instance !== null) found[name] = instance as HTMLElement
    }
    app.render(tree(grab))
    return found
  }

  it("getElementsByTagName is live, in document order, and excludes the element itself", () => {
    const found = mount((grab) => (
      <div ref={grab("root")} style={{ width: 200, height: 200 }}>
        <span ref={grab("a")} id="a" />
        <div>
          <span ref={grab("b")} id="b" />
        </div>
      </div>
    ))
    const spans = found.root.getElementsByTagName("span")
    expect(spans.length).toBe(2)
    expect(spans[0]).toBe(found.a)
    expect(spans.item(1)).toBe(found.b)
    expect(spans.namedItem("b")).toBe(found.b)
    expect([...spans]).toEqual([found.a, found.b])
    expect(found.root.getElementsByTagName("*").length).toBe(3)
    const added = document.createElement("span")
    found.root.appendChild(added)
    expect(spans.length).toBe(3)
    added.remove()
    expect(spans.length).toBe(2)
  })

  it("getElementsByClassName and getElementsByName", () => {
    const found = mount((grab) => (
      <div ref={grab("root")} style={{ width: 200, height: 200 }}>
        <input ref={grab("a")} name="field" className="one two" />
        <input ref={grab("b")} name="field" className="one" />
      </div>
    ))
    expect([...found.root.getElementsByClassName("one")]).toEqual([found.a, found.b])
    expect([...found.root.getElementsByClassName("two one")]).toEqual([found.a])
    expect(found.root.getElementsByClassName("").length).toBe(0)
    expect([...document.getElementsByName("field")]).toEqual([found.a, found.b])
  })

  it("document.head.getElementsByTagName works before a root mounts and after", () => {
    expect(document.head!.getElementsByTagName("style").length).toBe(0)
    mount(() => <div />)
    expect(document.head!.getElementsByTagName("style").length).toBe(0)
    expect(document.getElementsByTagName("body").length).toBe(1)
  })

  it("className is assigned as the class attribute", () => {
    const found = mount((grab) => <div ref={grab("el")} className="before" style={{ width: 50, height: 50 }} />)
    found.el.className = "a b"
    expect(found.el.className).toBe("a b")
    expect(found.el.getAttribute("class")).toBe("a b")
    expect(found.el.matches(".a.b")).toBe(true)
    expect(found.el.matches(".before")).toBe(false)
    const made = document.createElement("div")
    made.className = "made"
    expect(made.getAttribute("class")).toBe("made")
  })
})
