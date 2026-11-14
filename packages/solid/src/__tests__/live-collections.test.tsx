/**
 * `getElementsByTagName`, `getElementsByClassName` and `getElementsByName` on elements and on
 * `document`, the live lists they return, and the `className` setter, in Solid.
 */
import type { JSX } from "solid-js"
import { createSignal, Show } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
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

  describe("what a list found is kept until the tree or an attribute changes", () => {
    /** How many times the elements were asked for their `class`: once each per search of the tree. */
    function watchClassReads(elements: HTMLElement[]): () => number {
      const spies = elements.map((element) => vi.spyOn(element, "getAttribute"))
      return () => spies.reduce((total, spy) => total + spy.mock.calls.filter((call) => call[0] === "class").length, 0)
    }

    it("a loop over length and index searches the tree once, and so does a name no member has", () => {
      const found = mount((grab) => (
        <div ref={grab("root")} style={{ width: 200, height: 200 }}>
          <span ref={grab("a")} class="item" />
          <span ref={grab("b")} class="item" />
          <span ref={grab("c")} class="item" />
        </div>
      ))
      const reads = watchClassReads([found.a, found.b, found.c])
      const items = found.root.getElementsByClassName("item")
      const seen: Element[] = []
      for (let index = 0; index < items.length; index += 1) seen.push(items[index], items.item(index)!)
      expect(seen.length).toBe(6)
      expect(reads()).toBe(3)
      // A promise or a serializer asks a list for these; they read the kept list and search nothing.
      expect((items as unknown as Record<string, unknown>).then).toBeUndefined()
      expect((items as unknown as Record<string, unknown>).toJSON).toBeUndefined()
      expect((items as unknown as Record<string, unknown>)[Symbol.toPrimitive]).toBeUndefined()
      expect(reads()).toBe(3)
    })

    it("an element inserted and a class that changes after the list was read show in it", () => {
      const [on, setOn] = createSignal(false)
      const found = mount((grab) => (
        <div ref={grab("root")} style={{ width: 200, height: 200 }}>
          <span ref={grab("a")} class="item" />
          <span ref={grab("b")} classList={{ item: on() }} />
        </div>
      ))
      const items = found.root.getElementsByClassName("item")
      expect(items.length).toBe(1)
      setOn(true)
      expect(items.length).toBe(2)
      setOn(false)
      expect(items.length).toBe(1)
      const added = document.createElement("span")
      added.className = "item"
      found.root.appendChild(added)
      expect(items.length).toBe(2)
      expect(items[1]).toBe(added)
      added.setAttribute("class", "other")
      expect(items.length).toBe(1)
      found.a.classList.add("two")
      expect(found.root.getElementsByClassName("two").length).toBe(1)
      added.remove()
      expect(items.length).toBe(1)
    })

    it("a list on document follows a root that mounts and unmounts", () => {
      const spans = document.getElementsByTagName("span")
      expect(spans.length).toBe(0)
      mount(() => <span />)
      expect(spans.length).toBe(1)
      app?.unmount()
      app = undefined
      expect(spans.length).toBe(0)
    })
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
