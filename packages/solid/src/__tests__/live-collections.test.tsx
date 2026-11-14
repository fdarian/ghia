/**
 * `getElementsByTagName`, `getElementsByClassName` and `getElementsByName` on elements and on
 * `document`, the live lists they return, and the `className` setter, in Solid.
 */
import type { JSX } from "solid-js"
import { createSignal, Show } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("live element lists and className, in Solid", () => {
  let app: ReturnType<typeof createTestRoot> | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
  })

  function mount(tree: (grab: (name: string) => (instance: unknown) => void) => JSX.Element): Record<string, HTMLElement> {
    app = createTestRoot({ width: 400, height: 300 })
    const found: Record<string, HTMLElement> = {}
    const grab = (name: string) => (instance: unknown) => {
      if (instance !== null) found[name] = instance as HTMLElement
    }
    app.render(() => tree(grab))
    return found
  }

  it("getElementsByTagName on an element is live, in document order, and excludes the element itself", () => {
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
    expect(spans.item(2)).toBeNull()
    expect(spans[2]).toBeUndefined()
    expect(spans.namedItem("b")).toBe(found.b)
    expect(spans.b).toBe(found.b)
    expect([...spans]).toEqual([found.a, found.b])
    expect(Array.from(spans, (element) => element.id)).toEqual(["a", "b"])
    expect(found.root.getElementsByTagName("SPAN").length).toBe(2)
    expect(found.root.getElementsByTagName("*").length).toBe(3)
    expect(found.root.getElementsByTagName("div").length).toBe(1)
    expect(Object.prototype.toString.call(spans)).toBe("[object HTMLCollection]")
    expect(spans instanceof HTMLCollection).toBe(true)

    const added = document.createElement("span")
    found.root.appendChild(added)
    expect(spans.length).toBe(3)
    expect(spans[2]).toBe(added)
    added.remove()
    expect(spans.length).toBe(2)
  })

  it("getElementsByClassName matches every listed class, and nothing for an empty list", () => {
    const found = mount((grab) => (
      <div ref={grab("root")} style={{ width: 200, height: 200 }}>
        <span ref={grab("both")} class="one two" />
        <span ref={grab("one")} class="one" />
        <span ref={grab("none")} />
      </div>
    ))
    expect([...found.root.getElementsByClassName("one")]).toEqual([found.both, found.one])
    expect([...found.root.getElementsByClassName("two one")]).toEqual([found.both])
    expect(found.root.getElementsByClassName("").length).toBe(0)
    expect(found.root.getElementsByClassName("  ").length).toBe(0)
    const ones = document.getElementsByClassName("one")
    expect(ones.length).toBe(2)
    found.none.className = "one"
    expect(ones.length).toBe(3)
  })

  it("document.getElementsByName finds HTML elements by their name attribute", () => {
    const found = mount((grab) => (
      <div style={{ width: 200, height: 200 }}>
        <input ref={grab("a")} name="field" />
        <input ref={grab("b")} name="field" />
        <input ref={grab("c")} name="other" />
      </div>
    ))
    const fields = document.getElementsByName("field")
    expect(fields.length).toBe(2)
    expect(fields[0]).toBe(found.a)
    expect([...fields]).toEqual([found.a, found.b])
    expect(document.getElementsByName("missing").length).toBe(0)
  })

  it("document.head.getElementsByTagName works before a root mounts and after", () => {
    const before = document.head!.getElementsByTagName("style")
    expect(before.length).toBe(0)
    expect(document.getElementsByTagName("head").length).toBe(1)
    expect(document.getElementsByTagName("body").length).toBe(1)
    expect(document.getElementsByTagName("*").length).toBeGreaterThanOrEqual(3)
    mount(() => <div />)
    const after = document.head!.getElementsByTagName("style")
    expect(after.length).toBe(0)
    expect(document.getElementsByTagName("html").length).toBe(1)
    expect(document.body!.getElementsByTagName("div").length).toBeGreaterThanOrEqual(1)
  })

  it("an element's list follows what Solid renders", () => {
    const [shown, setShown] = createSignal(false)
    const found = mount((grab) => (
      <div ref={grab("root")} style={{ width: 200, height: 200 }}>
        <Show when={shown()}>
          <span class="late" />
        </Show>
      </div>
    ))
    const late = found.root.getElementsByClassName("late")
    expect(late.length).toBe(0)
    setShown(true)
    expect(late.length).toBe(1)
  })

  it("className is assigned as the class attribute", () => {
    const found = mount((grab) => <div ref={grab("el")} class="before" style={{ width: 50, height: 50 }} />)
    expect(found.el.className).toBe("before")
    found.el.className = "a b"
    expect(found.el.className).toBe("a b")
    expect(found.el.getAttribute("class")).toBe("a b")
    expect([...found.el.classList]).toEqual(["a", "b"])
    expect(found.el.matches(".a.b")).toBe(true)
    expect(found.el.matches(".before")).toBe(false)
    found.el.className = ""
    expect(found.el.getAttribute("class")).toBe("")

    const made = document.createElement("div")
    made.className = "made"
    expect(made.getAttribute("class")).toBe("made")
    expect(made.className).toBe("made")
  })
})
