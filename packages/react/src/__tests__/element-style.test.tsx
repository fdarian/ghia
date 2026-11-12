/**
 * `element.style` and `element.id` written from code on elements React renders: native gets
 * what code writes, a re-render keeps the properties it did not change, and
 * `getAttribute("style")` and `MutationObserver` see it as a browser has it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document, getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Handle = { nativeId: number }
type Rendered = { style?: Record<string, unknown>; id?: string; kind?: string }

describeNative("element.style and element.id in React", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  const observers: MutationObserver[] = []

  beforeEach(() => {
    testRoot = createTestRoot()
  })

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    testRoot.unmount()
  })

  /** Renders the div with `props`, and gives back the element and a function that renders it again. */
  function mount(initial: Rendered): { box: HTMLElement; rerender: (next: Rendered) => void } {
    let box: PublicInstance | null = null
    const tree = (props: Rendered) => (
      <div ref={(instance) => (box = instance ?? box)} id={props.id} data-kind={props.kind} style={props.style} />
    )
    testRoot.render(tree(initial))
    return { box: box as unknown as HTMLElement, rerender: (next) => testRoot.render(tree(next)) }
  }

  /** What code's change leaves for native: the flush a microtask does. */
  async function nativeStyle(element: Element): Promise<Record<string, unknown>> {
    await Promise.resolve()
    await Promise.resolve()
    testRoot.renderer.flush()
    return testRoot.renderer.getElement((element as unknown as Handle).nativeId)!.style as Record<string, unknown>
  }

  it("sends a custom property and translate to native", async () => {
    const { box } = mount({ style: { width: 30, height: 10 } })
    box.style.setProperty("--dnd-top", "10px")
    box.style.translate = "5px 6px"
    const style = await nativeStyle(box)
    expect(style["--dnd-top"]).toBe("10px")
    expect(style.translate).toBe("5px 6px")
    expect(style.width).toBe(30)
    expect(getComputedStyle(box).getPropertyValue("--dnd-top")).toBe("10px")
    expect(getComputedStyle(box).getPropertyValue("translate")).toBe("5px 6px")
  })

  it("removes a property from native, and reads back what it wrote", async () => {
    const { box } = mount({ style: { width: 30 } })
    box.style.setProperty("--dnd-left", "3px")
    expect(box.style.getPropertyValue("--dnd-left")).toBe("3px")
    expect(box.style.removeProperty("--dnd-left")).toBe("3px")
    expect(await nativeStyle(box)).not.toHaveProperty("--dnd-left")
    expect(box.style.width).toBe("30px")
  })

  it("reads the style React rendered on an element code never wrote to", () => {
    const { box } = mount({ style: { width: 30, opacity: 0.5 } })
    expect(box.style.cssText).toBe("width: 30px; opacity: 0.5;")
    expect(box.style.opacity).toBe("0.5")
  })

  it("keeps a code-written property when React changes another one", async () => {
    const { box, rerender } = mount({ style: { width: 30, height: 10 } })
    box.style.setProperty("--dnd-top", "10px")
    box.style.translate = "1px 2px"
    rerender({ style: { width: 40, height: 10 } })
    const style = await nativeStyle(box)
    expect(style.width).toBe(40)
    expect(style["--dnd-top"]).toBe("10px")
    expect(style.translate).toBe("1px 2px")
    expect(box.style.cssText).toContain("--dnd-top: 10px;")
  })

  it("keeps what code overwrote while React leaves that property as it was", async () => {
    const { box, rerender } = mount({ style: { width: 30, color: "red" } })
    box.style.width = "99px"
    rerender({ style: { width: 30, color: "blue" } })
    const style = await nativeStyle(box)
    expect(style.width).toBe(99)
    expect(style.color).toBe("blue")
  })

  it("lets React's change to a property overwrite code's", async () => {
    const { box, rerender } = mount({ style: { width: 30, height: 10 } })
    box.style.width = "99px"
    expect((await nativeStyle(box)).width).toBe(99)
    rerender({ style: { width: 40, height: 10 } })
    expect((await nativeStyle(box)).width).toBe(40)
    expect(box.style.width).toBe("40px")
  })

  it("lets React removing a property remove it", async () => {
    const { box, rerender } = mount({ style: { width: 30, height: 10 } })
    box.style.height = "77px"
    box.style.setProperty("--keep", "1")
    rerender({ style: { width: 30 } })
    const style = await nativeStyle(box)
    expect(style).not.toHaveProperty("height")
    expect(style["--keep"]).toBe("1")
  })

  it("keeps code's style when React drops the style prop's other properties and when it re-renders unchanged", async () => {
    const { box, rerender } = mount({ style: { width: 30 } })
    box.style.setProperty("--a", "1")
    rerender({ style: { width: 30 } })
    rerender({ style: { width: 30 }, kind: "b" })
    expect(await nativeStyle(box)).toMatchObject({ width: 30, "--a": "1" })
  })

  it("applies a style set by code before React's first change", async () => {
    const { box, rerender } = mount({ style: { width: 30 } })
    box.style.cssText = "height: 5px; --x: 2"
    expect(await nativeStyle(box)).toMatchObject({ height: 5, "--x": "2" })
    expect(await nativeStyle(box)).not.toHaveProperty("width")
    rerender({ style: { width: 31 } })
    expect(await nativeStyle(box)).toMatchObject({ width: 31, height: 5, "--x": "2" })
  })

  it("gives the code's style back when a node code took out is inserted again", async () => {
    const { box } = mount({ style: { width: 30 } })
    box.style.setProperty("--a", "1")
    box.remove()
    await Promise.resolve()
    await Promise.resolve()
    testRoot.renderer.flush()
    expect(box.style.getPropertyValue("--a")).toBe("1")
    document.body!.appendChild(box)
    expect(await nativeStyle(box)).toMatchObject({ width: 30, "--a": "1" })
  })

  it("gives getAttribute('style') as the text of the style, and \"\" once code emptied it", () => {
    const { box } = mount({ style: { width: 30, opacity: 0.5 } })
    expect(box.getAttribute("style")).toBe("width: 30px; opacity: 0.5;")
    expect(box.hasAttribute("style")).toBe(true)
    expect(box.getAttributeNames()).toContain("style")
    box.style.cssText = ""
    expect(box.getAttribute("style")).toBe("")
    expect(box.getAttributeNames()).toContain("style")
    box.removeAttribute("style")
    expect(box.getAttribute("style")).toBeNull()
    expect(box.getAttributeNames()).not.toContain("style")
    box.style.setProperty("--a", "1")
    expect(box.getAttribute("style")).toBe("--a: 1;")
  })

  it("tells a MutationObserver the style changed, with the old text, for code and for React", () => {
    const { box, rerender } = mount({ style: { width: 30 } })
    const observer = new MutationObserver(() => {})
    observer.observe(box, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    box.style.setProperty("--dnd-top", "10px")
    rerender({ style: { width: 40 } })
    box.style.removeProperty("--dnd-top")
    const records = observer.takeRecords()
    expect(records.map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["style", "width: 30px;"],
      ["style", "width: 30px; --dnd-top: 10px;"],
      ["style", "width: 40px; --dnd-top: 10px;"],
    ])
    box.style.setProperty("--dnd-top", "10px")
    box.style.setProperty("--dnd-top", "10px")
    expect(observer.takeRecords()).toHaveLength(1)
  })

  it("sets id from code, and a later render of other props keeps it", () => {
    const { box, rerender } = mount({ id: "first", kind: "a" })
    box.id = "second"
    expect(box.id).toBe("second")
    expect(box.getAttribute("id")).toBe("second")
    rerender({ id: "first", kind: "b" })
    expect(box.getAttribute("id")).toBe("second")
    expect(box.getAttribute("data-kind")).toBe("b")
    expect(box.getAttributeNames()).toContain("id")
  })

  it("sends id to native, and the next render that changes it overwrites code's", async () => {
    const { box, rerender } = mount({ id: "first" })
    box.id = "code"
    await nativeStyle(box)
    expect(testRoot.renderer.getElement((box as unknown as Handle).nativeId)!.customProps).toMatchObject({ id: "code" })
    rerender({ id: "third" })
    expect(box.getAttribute("id")).toBe("third")
    expect(testRoot.renderer.getElement((box as unknown as Handle).nativeId)!.customProps).toMatchObject({ id: "third" })
  })

  it("tells a MutationObserver of an id change from code and from React", () => {
    const { box, rerender } = mount({ id: "first" })
    const observer = new MutationObserver(() => {})
    observer.observe(box, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    box.id = "code"
    rerender({ id: "third" })
    expect(observer.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["id", "first"],
      ["id", "code"],
    ])
  })
})
