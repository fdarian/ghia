/**
 * `element.style` and `element.id` written from code on elements Solid renders: native gets
 * what code writes, a framework update keeps the properties it did not change, and
 * `getAttribute("style")` and `MutationObserver` see it as a browser has it.
 */
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

type Handle = { nativeId: number }

describe.skipIf(!hasNativeTestRenderer)("element.style and element.id in Solid", () => {
  let app: ReturnType<typeof createTestRoot>
  const observers: MutationObserver[] = []

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    app.unmount()
  })

  /** What code's change leaves for native: the flush a microtask does. */
  async function nativeStyle(element: Element): Promise<Record<string, unknown>> {
    await Promise.resolve()
    await Promise.resolve()
    app.renderer.flush()
    return app.renderer.getElement((element as unknown as Handle).nativeId)!.style as Record<string, unknown>
  }

  function mount(style: () => Record<string, unknown>, id?: () => string | undefined): HTMLElement {
    let box: HTMLElement | undefined
    app.render(() => (
      <div ref={(element) => (box = element as unknown as HTMLElement)} id={id?.()} style={style()} />
    ))
    return box!
  }

  it("sends a custom property and translate to native", async () => {
    const box = mount(() => ({ width: 30, height: 10 }))
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
    const box = mount(() => ({ width: 30 }))
    box.style.setProperty("--dnd-left", "3px")
    expect(box.style.getPropertyValue("--dnd-left")).toBe("3px")
    expect(box.style.removeProperty("--dnd-left")).toBe("3px")
    expect(await nativeStyle(box)).not.toHaveProperty("--dnd-left")
    expect(box.style.width).toBe("30px")
  })

  it("keeps a code-written property when the framework changes another one", async () => {
    const [width, setWidth] = createSignal(30)
    const box = mount(() => ({ width: width(), height: 10 }))
    box.style.setProperty("--dnd-top", "10px")
    box.style.translate = "1px 2px"
    setWidth(40)
    const style = await nativeStyle(box)
    expect(style.width).toBe(40)
    expect(style["--dnd-top"]).toBe("10px")
    expect(style.translate).toBe("1px 2px")
    expect(box.style.cssText).toContain("--dnd-top: 10px;")
  })

  it("keeps what code overwrote while the framework leaves that property as it was", async () => {
    const [color, setColor] = createSignal("red")
    const box = mount(() => ({ width: 30, color: color() }))
    box.style.width = "99px"
    setColor("blue")
    const style = await nativeStyle(box)
    expect(style.width).toBe(99)
    expect(style.color).toBe("blue")
  })

  it("lets the framework's change to a property overwrite code's", async () => {
    const [width, setWidth] = createSignal(30)
    const box = mount(() => ({ width: width(), height: 10 }))
    box.style.width = "99px"
    expect((await nativeStyle(box)).width).toBe(99)
    setWidth(40)
    expect((await nativeStyle(box)).width).toBe(40)
    expect(box.style.width).toBe("40px")
  })

  it("lets the framework removing a property remove it", async () => {
    const [tall, setTall] = createSignal(true)
    const box = mount(() => (tall() ? { width: 30, height: 10 } : { width: 30 }))
    box.style.height = "77px"
    box.style.setProperty("--keep", "1")
    setTall(false)
    const style = await nativeStyle(box)
    expect(style).not.toHaveProperty("height")
    expect(style["--keep"]).toBe("1")
  })

  it("applies a style set by code before the framework's first change", async () => {
    const [width, setWidth] = createSignal(30)
    const box = mount(() => ({ width: width() }))
    box.style.cssText = "height: 5px; --x: 2"
    expect(await nativeStyle(box)).toMatchObject({ height: 5, "--x": "2" })
    expect(await nativeStyle(box)).not.toHaveProperty("width")
    setWidth(31)
    expect(await nativeStyle(box)).toMatchObject({ width: 31, height: 5, "--x": "2" })
  })

  it("gives getAttribute('style') as the text of the style, and null when it is empty", async () => {
    const box = mount(() => ({ width: 30, opacity: 0.5 }))
    expect(box.getAttribute("style")).toBe("width: 30px; opacity: 0.5;")
    expect(box.hasAttribute("style")).toBe(true)
    expect(box.getAttributeNames()).toContain("style")
    box.style.cssText = ""
    expect(box.getAttribute("style")).toBeNull()
    expect(box.getAttributeNames()).not.toContain("style")
    box.style.setProperty("--a", "1")
    expect(box.getAttribute("style")).toBe("--a: 1;")
  })

  it("tells a MutationObserver the style changed, with the old text, for code and for the framework", async () => {
    const [width, setWidth] = createSignal(30)
    const box = mount(() => ({ width: width() }))
    const observer = new MutationObserver(() => {})
    observer.observe(box, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    box.style.setProperty("--dnd-top", "10px")
    setWidth(40)
    box.style.removeProperty("--dnd-top")
    const records = observer.takeRecords()
    expect(records.map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["style", "width: 30px;"],
      ["style", "width: 30px; --dnd-top: 10px;"],
      ["style", "--dnd-top: 10px; width: 40px;"],
    ])
    box.style.setProperty("--dnd-top", "10px")
    box.style.setProperty("--dnd-top", "10px")
    expect(observer.takeRecords()).toHaveLength(1)
  })

  it("sets id from code, and the framework's later render of other props keeps it", async () => {
    const [kind, setKind] = createSignal("a")
    let box: HTMLElement | undefined
    app.render(() => (
      <div ref={(element) => (box = element as unknown as HTMLElement)} id="first" data-kind={kind()} />
    ))
    box!.id = "second"
    expect(box!.id).toBe("second")
    expect(box!.getAttribute("id")).toBe("second")
    setKind("b")
    expect(box!.getAttribute("id")).toBe("second")
    expect(box!.getAttribute("data-kind")).toBe("b")
    expect(box!.getAttributeNames()).toContain("id")
  })

  it("lets the framework's change to id overwrite code's, and tells a MutationObserver of both", async () => {
    const [id, setId] = createSignal("first")
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} id={id()} />)
    const observer = new MutationObserver(() => {})
    observer.observe(box!, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    box!.id = "code"
    setId("third")
    expect(box!.getAttribute("id")).toBe("third")
    expect(observer.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["id", "first"],
      ["id", "code"],
    ])
  })
})
