/** `element.style` on a Solid element: the patterns Base UI writes and reads, and how a re-render treats what was written. */
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { appliedBatchCount, getComputedStyle } from "@ghia/native/host"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("element.style on a Solid element", () => {
  const apps: ReturnType<typeof createTestRoot>[] = []
  const observers: MutationObserver[] = []

  function setup(render: () => import("solid-js").JSX.Element) {
    const app = createTestRoot({ width: 300, height: 200 })
    apps.push(app)
    app.renderer.clockPause()
    app.renderer.setInlineDraws(false)
    app.render(render)
    app.renderer.drawFrame()
    return app
  }

  const height = (element: HostElement) => element.getBoundingClientRect().height

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    for (const app of apps.splice(0)) app.unmount()
  })

  it("reads the framework's style as CSS text, as React DOM writes it", () => {
    let target!: HostElement
    setup(() => (
      <div
        ref={target}
        style={{ width: 40, height: "20px", opacity: 0.5, zIndex: 3, lineHeight: 1.5, margin: 0, "--gap": 8 } as never}
      />
    ))
    const style = target.style
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
    expect([...style]).toEqual(["width", "height", "opacity", "z-index", "line-height", "margin", "--gap"])
    expect(target.style).toBe(style)
  })

  it("is a CSSStyleDeclaration that cannot be constructed", () => {
    let target!: HostElement
    setup(() => <div ref={target} />)
    expect(target.style).toBeInstanceOf(CSSStyleDeclaration)
    expect(() => new (CSSStyleDeclaration as unknown as new () => object)()).toThrow(TypeError)
  })

  it("does what Base UI does: custom properties, important, restore, remove and assign", () => {
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: 40, height: 20 }} />)
    const style = target.style

    style.setProperty("--drawer-swipe-movement-y", "12px")
    expect(style.getPropertyValue("--drawer-swipe-movement-y")).toBe("12px")

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
    expect([style.height, style.transform, style.transition, style.pointerEvents, style.opacity, style.top]).toEqual([
      "50px",
      "translateY(10px)",
      "none",
      "none",
      "0.5",
      "3px",
    ])
    expect(style.paddingBottom).toBe("2px")
    style.height = ""
    expect(style.height).toBe("")
  })

  it("lays out and paints what was written, before any frame", () => {
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: 40, height: 20 }} />)
    expect(height(target)).toBe(20)
    target.style.height = "50px"
    expect(height(target)).toBe(50)
    target.style.width = "60px"
    expect(target.getBoundingClientRect().width).toBe(60)
    target.style.opacity = "0.5"
    target.style.transform = "translateY(10px)"
    const computed = getComputedStyle(target as unknown as Element)
    expect(computed.getPropertyValue("opacity")).toBe("0.5")
    expect(computed.getPropertyValue("height")).toBe("50px")
    const top = target.getBoundingClientRect().top
    target.style.transform = "translateY(30px)"
    expect(target.getBoundingClientRect().top).toBe(top + 20)
    target.style.removeProperty("height")
    expect(height(target)).not.toBe(50)
  })

  it("feeds a var() in the framework style from a custom property it sets", () => {
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: "var(--w)", height: 20 }} />)
    target.style.setProperty("--w", "60px")
    expect(target.getBoundingClientRect().width).toBe(60)
    target.style.setProperty("--w", "90px")
    expect(target.getBoundingClientRect().width).toBe(90)
  })

  // Chrome stores a property it knows that Ghia has no style key for (touch-action); main ignores it. Pending a decision.
  it.skip("stores a property Ghia has no style key for and applies nothing for it", () => {
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: 40, height: 20 }} />)
    target.style.setProperty("some-unknown-thing", "5", "important")
    target.style.setProperty("scroll-snap-type", "x mandatory")
    expect(target.style.getPropertyValue("some-unknown-thing")).toBe("5")
    expect(target.style.getPropertyPriority("some-unknown-thing")).toBe("important")
    expect(target.style.scrollSnapType).toBe("x mandatory")
    expect(height(target)).toBe(20)
  })

  it("lets a re-render overwrite only the properties it changed", () => {
    const [width, setWidth] = createSignal(40)
    const [opacity, setOpacity] = createSignal(1)
    const [withHeight, setWithHeight] = createSignal(true)
    let target!: HostElement
    setup(() => (
      <div ref={target} style={withHeight() ? { width: width(), height: 20, opacity: opacity() } : { width: width(), opacity: opacity() }} />
    ))
    target.style.height = "60px"
    target.style.setProperty("--x", "1px")
    target.style.opacity = "0.25"
    target.style.color = "red"

    setWidth(50)
    expect(target.style.width).toBe("50px")
    expect(target.style.height).toBe("60px")
    expect(target.style.opacity).toBe("0.25")
    expect(target.style.color).toBe("red")
    expect(target.style.getPropertyValue("--x")).toBe("1px")
    expect(height(target)).toBe(60)
    expect(target.getBoundingClientRect().width).toBe(50)

    setOpacity(0.75)
    expect(target.style.opacity).toBe("0.75")
    expect(target.style.height).toBe("60px")

    setWithHeight(false)
    expect(target.style.height).toBe("")
    expect(target.style.color).toBe("red")
  })

  it("removes a framework value too, until the framework commits it again", () => {
    const [value, setValue] = createSignal(20)
    const [other, setOther] = createSignal(0)
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: 40 + other(), height: value() }} />)
    target.style.removeProperty("height")
    expect(target.style.height).toBe("")
    setOther(1)
    expect(target.style.height).toBe("")
    setValue(30)
    expect(target.style.height).toBe("30px")
    expect(height(target)).toBe(30)
  })

  it("round-trips cssText and parses declarations", () => {
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: 40, height: 20 }} />)
    const style = target.style
    expect(style.cssText).toBe("width: 40px; height: 20px;")
    style.cssText = "HEIGHT: 33px ; /* note */ color:rgb(1, 2, 3) !important; --a: 'x;y'; broken; : nothing; background-image: url(data:a;b)"
    expect(style.cssText).toBe(
      "height: 33px; color: rgb(1, 2, 3) !important; --a: 'x;y'; background-image: url(data:a;b);"
    )
    expect(style.getPropertyPriority("color")).toBe("important")
    expect(style.width).toBe("")
    expect(height(target)).toBe(33)
    style.cssText = ""
    expect(style.cssText).toBe("")
    expect(style.length).toBe(0)
    style.cssText = "width: 10px"
    expect(target.getBoundingClientRect().width).toBe(10)
    target.style = "height: 7px" as unknown as CSSStyleDeclaration
    expect(style.cssText).toBe("height: 7px;")
  })

  it("is the style attribute: setAttribute, getAttribute, removeAttribute and getAttributeNames", () => {
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: 40, height: 20 }} />)
    expect(target.getAttribute("style")).toBe("width: 40px; height: 20px;")
    expect(target.getAttributeNames()).toContain("style")
    target.setAttribute("style", "height: 44px; color: red")
    expect(target.getAttribute("STYLE")).toBe("height: 44px; color: red;")
    expect(target.style.height).toBe("44px")
    expect(height(target)).toBe(44)
    target.removeAttribute("style")
    expect(target.getAttribute("style")).toBeNull()
    expect(target.getAttributeNames()).not.toContain("style")
    expect(target.hasAttribute("style")).toBe(false)
  })

  it("records one style attribute mutation per write, with the cssText before as oldValue", () => {
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: 40, height: 20 }} />)
    const observer = new MutationObserver(() => {})
    observer.observe(target, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    const style = target.style
    style.setProperty("--a", "1px")
    style.setProperty("--a", "1px")
    style.height = "30px"
    style.removeProperty("width")
    style.removeProperty("never-set")
    style.cssText = "color: red"
    target.setAttribute("style", "color: red")
    expect(observer.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["style", "width: 40px; height: 20px;"],
      ["style", "width: 40px; height: 20px; --a: 1px;"],
      ["style", "width: 40px; height: 30px; --a: 1px;"],
      ["style", "height: 30px; --a: 1px;"],
    ])
  })

  it("records the framework's own style change as a style attribute mutation", () => {
    const [value, setValue] = createSignal(20)
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: 40, height: value() }} />)
    const observer = new MutationObserver(() => {})
    observer.observe(target, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    setValue(30)
    expect(observer.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["style", "width: 40px; height: 20px;"],
    ])
  })

  it("queues writes and sends them once, before a read and before the next frame", async () => {
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: 40, height: 20, opacity: 1, color: "red", margin: 0 }} />)
    await Promise.resolve()
    const style = target.style
    const before = appliedBatchCount()
    for (let index = 0; index < 100; index++) style.setProperty("--x", `${index}px`)
    expect(appliedBatchCount()).toBe(before)
    expect(style.getPropertyValue("--x")).toBe("99px")
    await Promise.resolve()
    expect(appliedBatchCount()).toBe(before + 1)
    style.height = "70px"
    expect(appliedBatchCount()).toBe(before + 1)
    expect(height(target)).toBe(70)
    expect(appliedBatchCount()).toBe(before + 2)
  })

  it("writes nothing for a value it already has", async () => {
    let target!: HostElement
    setup(() => <div ref={target} style={{ width: 40, height: 20 }} />)
    await Promise.resolve()
    const before = appliedBatchCount()
    target.style.width = "40px"
    target.style.setProperty("height", "20px")
    await Promise.resolve()
    expect(appliedBatchCount()).toBe(before)
  })

  it("keeps the state style of an element when cssText is replaced", async () => {
    let target!: HostElement
    const app = setup(() => <div ref={target} style={{ width: 40, height: 20, hover: { opacity: 0.5 } }} />)
    target.style.cssText = "width: 10px"
    expect(target.style.cssText).toBe("width: 10px;")
    // A state style is no CSS text: `cssText` neither lists nor removes it.
    target.style.cssText = ""
    expect(target.style.length).toBe(0)
    await Promise.resolve()
    app.renderer.flush()
  })

  it("writes to an element that is not in a root, or is gone, without failing", async () => {
    const [shown, setShown] = createSignal(true)
    let target!: HostElement
    setup(() => (shown() ? <div ref={target} style={{ width: 40, height: 20 }} /> : <span />))
    const gone = target
    setShown(false)
    gone.style.height = "5px"
    await Promise.resolve()
    expect(gone.style.height).toBe("5px")
  })
})
