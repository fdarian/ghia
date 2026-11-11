/** `element.style` on a React host instance: the patterns Base UI writes and reads, and how a re-render treats what was written. */
import { afterEach, describe, expect, it } from "vitest"
import { appliedBatchCount, getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("element.style on a React host instance", () => {
  const roots: ReturnType<typeof createTestRoot>[] = []
  const observers: MutationObserver[] = []

  function setup(element: React.ReactElement) {
    const root = createTestRoot({ width: 300, height: 200 })
    roots.push(root)
    root.render(element)
    return root
  }

  const height = (element: PublicInstance) => element.getBoundingClientRect().height

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    for (const root of roots.splice(0)) root.unmount()
  })

  it("reads the framework's style as CSS text, as React DOM writes it", () => {
    let element: PublicInstance | null = null
    setup(
      <div
        ref={(instance) => (element = instance)}
        style={{ width: 40, height: "20px", opacity: 0.5, zIndex: 3, lineHeight: 1.5, margin: 0, "--gap": 8 } as React.CSSProperties}
      />
    )
    const style = element!.style
    expect(style.width).toBe("40px")
    expect(style.height).toBe("20px")
    expect(style.opacity).toBe("0.5")
    expect(style.zIndex).toBe("3")
    expect(style.lineHeight).toBe("1.5")
    expect(style.margin).toBe("0")
    expect(style.getPropertyValue("--gap")).toBe("8")
    expect(style.getPropertyValue("z-index")).toBe("3")
    expect(style.paddingTop).toBe("")
    expect(style.length).toBe(7)
    expect(style.item(0)).toBe("width")
    expect([...style]).toEqual(["width", "height", "opacity", "z-index", "line-height", "margin", "--gap"])
    expect(element!.style).toBe(style)
    expect(style.parentRule).toBeNull()
  })

  it("is a CSSStyleDeclaration that cannot be constructed", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} />)
    expect(element!.style).toBeInstanceOf(CSSStyleDeclaration)
    expect(() => new (CSSStyleDeclaration as unknown as new () => object)()).toThrow(TypeError)
  })

  it("does what Base UI does: custom properties, important, restore, remove and assign", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={{ width: 40, height: 20 }} />)
    const style = element!.style

    style.setProperty("--drawer-swipe-movement-y", "12px")
    expect(style.getPropertyValue("--drawer-swipe-movement-y")).toBe("12px")
    expect(style.getPropertyPriority("--drawer-swipe-movement-y")).toBe("")

    // Save, force `initial` with priority, and restore with the old priority.
    style.setProperty("transform", "translateY(4px)", "important")
    const previousValue = style.getPropertyValue("transform")
    const previousPriority = style.getPropertyPriority("transform")
    expect([previousValue, previousPriority]).toEqual(["translateY(4px)", "important"])
    style.setProperty("transform", "initial", "important")
    expect(style.transform).toBe("initial")
    style.setProperty("transform", previousValue, previousPriority)
    expect(style.transform).toBe("translateY(4px)")
    expect(style.getPropertyPriority("transform")).toBe("important")
    style.setProperty("transform", "none")
    expect(style.getPropertyPriority("transform")).toBe("")

    style.setProperty("visibility", "hidden")
    expect(style.removeProperty("visibility")).toBe("hidden")
    expect(style.removeProperty("visibility")).toBe("")
    style.setProperty("pointer-events", "none")
    style.removeProperty("pointer-events")
    style.setProperty("transition", "none")
    expect(style.removeProperty("transition")).toBe("none")
    style.removeProperty("--drawer-swipe-movement-y")
    expect(style.getPropertyValue("--drawer-swipe-movement-y")).toBe("")

    style.height = "50px"
    style.transform = "translateY(10px)"
    style.transition = "none"
    style.pointerEvents = "none"
    style.opacity = "0.5"
    style.top = "3px"
    style.paddingBottom = "2px"
    style.scrollSnapType = "none"
    style.scrollPaddingBottom = "4px"
    style.overflowAnchor = "none"
    expect([style.height, style.transform, style.transition, style.pointerEvents, style.opacity, style.top]).toEqual([
      "50px",
      "translateY(10px)",
      "none",
      "none",
      "0.5",
      "3px",
    ])
    expect([style.paddingBottom, style.scrollSnapType, style.scrollPaddingBottom, style.overflowAnchor]).toEqual([
      "2px",
      "none",
      "4px",
      "none",
    ])
    style.height = ""
    expect(style.height).toBe("")
    style.top = null as unknown as string
    expect(style.top).toBe("")
    expect(style.cssFloat).toBe("")
  })

  it("lays out and paints what was written, before any frame", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={{ width: 40, height: 20 }} />)
    expect(height(element!)).toBe(20)
    element!.style.height = "50px"
    expect(height(element!)).toBe(50)
    element!.style.width = "60px"
    expect(element!.getBoundingClientRect().width).toBe(60)
    element!.style.opacity = "0.5"
    element!.style.transform = "translateY(10px)"
    const computed = getComputedStyle(element as unknown as Element)
    expect(computed.getPropertyValue("opacity")).toBe("0.5")
    expect(computed.getPropertyValue("height")).toBe("50px")
    const top = element!.getBoundingClientRect().top
    element!.style.transform = "translateY(30px)"
    expect(element!.getBoundingClientRect().top).toBe(top + 20)
    element!.style.removeProperty("height")
    expect(height(element!)).not.toBe(50)
  })

  it("feeds a var() in the framework style from a custom property it sets", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={{ width: "var(--w)", height: 20 }} />)
    element!.style.setProperty("--w", "60px")
    expect(element!.getBoundingClientRect().width).toBe(60)
    element!.style.setProperty("--w", "90px")
    expect(element!.getBoundingClientRect().width).toBe(90)
  })

  it("stores a property Ghia has no style key for and applies nothing for it", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={{ width: 40, height: 20 }} />)
    element!.style.setProperty("some-unknown-thing", "5", "important")
    element!.style.setProperty("scroll-snap-type", "x mandatory")
    expect(element!.style.getPropertyValue("some-unknown-thing")).toBe("5")
    expect(element!.style.getPropertyPriority("some-unknown-thing")).toBe("important")
    expect(element!.style.scrollSnapType).toBe("x mandatory")
    expect(height(element!)).toBe(20)
  })

  it("lets a re-render overwrite only the properties it changed", () => {
    let element: PublicInstance | null = null
    const view = (width: number, opacity: number) => (
      <div ref={(instance) => (element = instance)} style={{ width, height: 20, opacity }} />
    )
    const root = setup(view(40, 1))
    element!.style.height = "60px"
    element!.style.setProperty("--x", "1px")
    element!.style.opacity = "0.25"
    element!.style.color = "red"

    root.render(view(50, 1))
    expect(element!.style.width).toBe("50px")
    expect(element!.style.height).toBe("60px")
    expect(element!.style.opacity).toBe("0.25")
    expect(element!.style.color).toBe("red")
    expect(element!.style.getPropertyValue("--x")).toBe("1px")
    expect(height(element!)).toBe(60)
    expect(element!.getBoundingClientRect().width).toBe(50)

    root.render(view(50, 0.75))
    expect(element!.style.opacity).toBe("0.75")
    expect(element!.style.height).toBe("60px")

    const withoutHeight = (
      <div ref={(instance) => (element = instance)} style={{ width: 50, opacity: 0.75 }} />
    )
    root.render(withoutHeight)
    expect(element!.style.height).toBe("")
    expect(element!.style.color).toBe("red")
  })

  it("removes a framework value too, until the framework commits it again", () => {
    let element: PublicInstance | null = null
    const view = (height: number) => <div ref={(instance) => (element = instance)} style={{ width: 40, height }} />
    const root = setup(view(20))
    element!.style.removeProperty("height")
    expect(element!.style.height).toBe("")
    root.render(view(20))
    expect(element!.style.height).toBe("")
    root.render(view(30))
    expect(element!.style.height).toBe("30px")
    expect(height(element!)).toBe(30)
  })

  it("round-trips cssText and parses declarations", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={{ width: 40, height: 20 }} />)
    const style = element!.style
    expect(style.cssText).toBe("width: 40px; height: 20px;")
    style.cssText = "HEIGHT: 33px ; /* note */ color:rgb(1, 2, 3) !important; --a: 'x;y'; broken; : nothing; background-image: url(data:a;b)"
    expect(style.cssText).toBe(
      "height: 33px; color: rgb(1, 2, 3) !important; --a: 'x;y'; background-image: url(data:a;b);"
    )
    expect(style.getPropertyPriority("color")).toBe("important")
    expect(style.width).toBe("")
    expect(height(element!)).toBe(33)
    style.cssText = ""
    expect(style.cssText).toBe("")
    expect(style.length).toBe(0)
    style.cssText = "width: 10px"
    expect(element!.getBoundingClientRect().width).toBe(10)
    element!.style = "height: 7px" as unknown as CSSStyleDeclaration
    expect(style.cssText).toBe("height: 7px;")
  })

  it("is the style attribute: setAttribute, getAttribute, removeAttribute and getAttributeNames", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={{ width: 40, height: 20 }} />)
    expect(element!.getAttribute("style")).toBe("width: 40px; height: 20px;")
    expect(element!.getAttributeNames()).toContain("style")
    element!.setAttribute("style", "height: 44px; color: red")
    expect(element!.getAttribute("STYLE")).toBe("height: 44px; color: red;")
    expect(element!.style.height).toBe("44px")
    expect(height(element!)).toBe(44)
    element!.removeAttribute("style")
    expect(element!.getAttribute("style")).toBeNull()
    expect(element!.getAttributeNames()).not.toContain("style")
    expect(element!.hasAttribute("style")).toBe(false)
    element!.setAttribute("style", "")
    expect(element!.getAttribute("style")).toBe("")
  })

  it("records one style attribute mutation per write, with the cssText before as oldValue", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={{ width: 40, height: 20 }} />)
    const observer = new MutationObserver(() => {})
    observer.observe(element!, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    const style = element!.style
    style.setProperty("--a", "1px")
    style.setProperty("--a", "1px")
    style.height = "30px"
    style.removeProperty("width")
    style.removeProperty("never-set")
    style.cssText = "color: red"
    element!.setAttribute("style", "color: red")
    const records = observer.takeRecords()
    expect(records.map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["style", "width: 40px; height: 20px;"],
      ["style", "width: 40px; height: 20px; --a: 1px;"],
      ["style", "width: 40px; height: 30px; --a: 1px;"],
      ["style", "height: 30px; --a: 1px;"],
    ])
  })

  it("records the framework's own style change as a style attribute mutation", () => {
    let element: PublicInstance | null = null
    const view = (height: number) => <div ref={(instance) => (element = instance)} style={{ width: 40, height }} />
    const root = setup(view(20))
    const observer = new MutationObserver(() => {})
    observer.observe(element!, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    root.render(view(30))
    expect(observer.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["style", "width: 40px; height: 20px;"],
    ])
  })

  it("queues writes and sends them once, before a read and before the next frame", async () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={{ width: 40, height: 20, opacity: 1, color: "red", margin: 0 }} />)
    const style = element!.style
    const before = appliedBatchCount()
    for (let index = 0; index < 100; index++) style.setProperty("--x", `${index}px`)
    expect(appliedBatchCount()).toBe(before)
    expect(style.getPropertyValue("--x")).toBe("99px")
    await Promise.resolve()
    expect(appliedBatchCount()).toBe(before + 1)
    style.height = "70px"
    expect(appliedBatchCount()).toBe(before + 1)
    expect(height(element!)).toBe(70)
    expect(appliedBatchCount()).toBe(before + 2)
  })

  it("writes nothing for a value it already has", async () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={{ width: 40, height: 20 }} />)
    await Promise.resolve()
    const before = appliedBatchCount()
    element!.style.width = "40px"
    element!.style.setProperty("height", "20px")
    await Promise.resolve()
    expect(appliedBatchCount()).toBe(before)
  })

  it("keeps the state style of an element when cssText is replaced", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={{ width: 40, height: 20, hover: { opacity: 0.5 } }} />)
    element!.style.cssText = "width: 10px"
    expect(element!.style.cssText).toBe("width: 10px;")
    expect((element!.props.style as Record<string, unknown>).hover).toEqual({ opacity: 0.5 })
  })

  it("writes to an element that is not mounted yet or is gone without failing", async () => {
    let element: PublicInstance | null = null
    const root = setup(<div ref={(instance) => (element = instance)} style={{ width: 40, height: 20 }} />)
    const gone = element!
    root.render(<span />)
    gone.style.height = "5px"
    await Promise.resolve()
    expect(gone.style.height).toBe("5px")
  })
})
