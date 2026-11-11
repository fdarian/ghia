/** `setAttribute`, `removeAttribute` and `toggleAttribute` on a Solid element: the write has the effect of the prop. */
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const box = { width: 40, height: 20 }

describe.skipIf(!hasNativeTestRenderer)("attribute writes on a Solid element", () => {
  const apps: ReturnType<typeof createTestRoot>[] = []
  const observers: MutationObserver[] = []

  function setup(render: () => import("solid-js").JSX.Element) {
    const app = createTestRoot({ width: 300, height: 200 })
    apps.push(app)
    app.renderer.clockPause()
    app.renderer.setInlineDraws(false)
    app.render(render)
    app.renderer.drawFrame()
    const renderer = app.renderer
    const idOf = (testId: string) => renderer.findByTestId(testId)!.id
    const focused = () => renderer.getElement(renderer.getFocusedElementId())?.testId ?? null
    const center = (testId: string): [number, number] => {
      const bounds = renderer.getElementBounds(idOf(testId))!
      return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
    }
    return { app, renderer, idOf, focused, center }
  }

  function ariaOf(tree: ReturnType<ReturnType<typeof createTestRoot>["renderer"]["getA11yTree"]>, label: string) {
    return Object.values(tree.nodes ?? {}).find((node) => node.aria?.label === label)?.aria
  }

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    for (const app of apps.splice(0)) app.unmount()
  })

  it("round-trips set, remove and toggle through getAttribute, hasAttribute, getAttributeNames and dataset", () => {
    let target!: HostElement
    setup(() => <div ref={target} testId="box" data-kept="1" style={box} />)
    expect(target.hasAttribute("data-extra")).toBe(false)
    target.setAttribute("data-extra", "x")
    target.setAttribute("DATA-Other", "y")
    expect(target.getAttribute("data-extra")).toBe("x")
    expect(target.hasAttribute("data-extra")).toBe(true)
    expect(target.getAttributeNames().sort()).toEqual(["data-extra", "data-kept", "data-other", "style", "testid"].sort())
    expect(target.dataset).toEqual({ kept: "1", extra: "x", other: "y" })
    target.setAttribute("data-extra", 5 as unknown as string)
    expect(target.getAttribute("data-extra")).toBe("5")
    target.removeAttribute("data-extra")
    expect(target.getAttribute("data-extra")).toBeNull()
    expect(target.hasAttribute("data-extra")).toBe(false)
    target.removeAttribute("data-never-set")

    expect(target.toggleAttribute("data-flag")).toBe(true)
    expect(target.getAttribute("data-flag")).toBe("")
    expect(target.toggleAttribute("data-flag")).toBe(false)
    expect(target.hasAttribute("data-flag")).toBe(false)
    expect(target.toggleAttribute("data-flag", true)).toBe(true)
    expect(target.toggleAttribute("data-flag", true)).toBe(true)
    expect(target.toggleAttribute("data-flag", false)).toBe(false)
    expect(target.toggleAttribute("data-flag", false)).toBe(false)
  })

  it("reflects a typed prop as the browser does: tabindex as a number, a boolean attribute by presence", () => {
    let target!: HostElement
    setup(() => <div ref={target} style={box} />)
    target.setAttribute("tabindex", "-1")
    expect(target.getAttribute("tabindex")).toBe("-1")
    expect(target.props.get("tabIndex")).toBe(-1)
    target.setAttribute("hidden", "any text")
    expect(target.props.get("hidden")).toBe(true)
    expect(target.getAttribute("hidden")).toBe("")
    target.toggleAttribute("hidden")
    expect(target.hasAttribute("hidden")).toBe(false)
    target.setAttribute("class", "a b")
    expect(target.getAttribute("class")).toBe("a b")
    expect(target.className).toBe("a b")
  })

  it("keeps the prop name the framework used for an attribute", () => {
    let target!: HostElement
    setup(() => <div ref={target} tabIndex={0} class="first" style={box} />)
    target.setAttribute("tabindex", "2")
    target.setAttribute("class", "second")
    expect(target.props.get("tabIndex")).toBe(2)
    expect(target.props.has("tabindex")).toBe(false)
    expect(target.props.get("class")).toBe("second")
    expect(target.props.has("className")).toBe(false)
  })

  it("throws InvalidCharacterError for a name the DOM rejects", () => {
    let target!: HostElement
    setup(() => <div ref={target} style={box} />)
    expect(() => target.setAttribute("a b", "1")).toThrow(expect.objectContaining({ name: "InvalidCharacterError" }))
    expect(() => target.setAttribute("", "1")).toThrow(expect.objectContaining({ name: "InvalidCharacterError" }))
  })

  it("keeps on* as text for getAttribute and sends nothing to native", () => {
    const clicks: string[] = []
    let target!: HostElement
    const { renderer, center } = setup(() => (
      <div ref={target} testId="box" style={box} onClick={() => clicks.push("prop")} />
    ))
    target.setAttribute("onclick", "alert(1)")
    expect(target.getAttribute("onclick")).toBe("alert(1)")
    expect(target.getAttributeNames()).toEqual(expect.arrayContaining(["onclick"]))
    renderer.nativeSimulateClick(...center("box"))
    expect(clicks).toEqual(["prop"])
  })

  it("makes an element focusable with tabindex -1 and a tab stop with 0", () => {
    let skipped!: HostElement
    let stop!: HostElement
    const { renderer, focused, idOf } = setup(() => (
      <div style={{ width: 200, height: 100 }}>
        <div testId="first" tabIndex={0} style={box} />
        <div ref={skipped} testId="skipped" style={box} />
        <div ref={stop} testId="stop" style={box} />
      </div>
    ))
    renderer.focusElement(idOf("skipped"))
    expect(focused()).toBeNull()

    skipped.setAttribute("tabindex", "-1")

    renderer.drawFrame()
    renderer.focusElement(idOf("skipped"))
    expect(focused()).toBe("skipped")
    renderer.focusElement(idOf("first"))
    renderer.simulateKeystrokes("Tab")
    expect(focused()).toBe("first")

    stop.setAttribute("tabindex", "0")

    renderer.drawFrame()
    renderer.simulateKeystrokes("Tab")
    expect(focused()).toBe("stop")

    stop.setAttribute("tabindex", "-1")

    renderer.drawFrame()
    renderer.focusElement(idOf("first"))
    renderer.simulateKeystrokes("Tab")
    expect(focused()).toBe("first")
    stop.removeAttribute("tabindex")
    renderer.drawFrame()
    renderer.focusElement(idOf("stop"))
    expect(focused()).toBe("first")
  })

  it("hides an element from the accessibility tree with aria-hidden, and shows it again", () => {
    let target!: HostElement
    const { renderer } = setup(() => (
      <div ref={target} style={{ width: 120, height: 40 }}>
        <div role="button" aria-label="inside" style={box} />
      </div>
    ))
    expect(ariaOf(renderer.getA11yTree(), "inside")?.hidden).toBeFalsy()
    target.setAttribute("aria-hidden", "true")
    renderer.drawFrame()
    expect(ariaOf(renderer.getA11yTree(), "inside")?.hidden).toBe(true)
    target.removeAttribute("aria-hidden")
    renderer.drawFrame()
    expect(ariaOf(renderer.getA11yTree(), "inside")?.hidden).toBeFalsy()
    target.setAttribute("aria-hidden", "false")
    renderer.drawFrame()
    expect(ariaOf(renderer.getA11yTree(), "inside")?.hidden).toBeFalsy()
  })

  it("makes a subtree inert: no pointer, no focus, no accessibility node", () => {
    const clicks: string[] = []
    let region!: HostElement
    const { renderer, idOf, focused, center } = setup(() => (
      <div ref={region} style={{ width: 200, height: 100 }}>
        <div
          role="button"
          aria-label="inner"
          testId="inner"
          tabIndex={0}
          style={box}
          onClick={() => clicks.push("inner")}
        />
      </div>
    ))
    renderer.nativeSimulateClick(...center("inner"))
    expect(clicks).toEqual(["inner"])
    renderer.focusElement(idOf("inner"))
    expect(focused()).toBe("inner")

    region.setAttribute("inert", "")

    renderer.drawFrame()
    expect(focused()).toBeNull()
    renderer.focusElement(idOf("inner"))
    expect(focused()).toBeNull()
    renderer.nativeSimulateClick(...center("inner"))
    expect(clicks).toEqual(["inner"])
    expect(ariaOf(renderer.getA11yTree(), "inner")?.hidden).toBe(true)

    region.removeAttribute("inert")

    renderer.drawFrame()
    renderer.nativeSimulateClick(...center("inner"))
    expect(clicks).toEqual(["inner", "inner"])
    renderer.focusElement(idOf("inner"))
    expect(focused()).toBe("inner")
  })

  it("lets a later commit of the same prop win, and leaves what the framework never set", () => {
    const [label, setLabel] = createSignal("one")
    const [other, setOther] = createSignal(0)
    let target!: HostElement
    setup(() => <div ref={target} data-label={label()} data-other={other()} data-stays="a" style={box} />)
    target.setAttribute("data-label", "written")
    target.setAttribute("data-other", "written")
    target.setAttribute("data-added", "kept")
    target.removeAttribute("data-stays")

    setOther(1)
    expect(target.getAttribute("data-label")).toBe("written")
    expect(target.getAttribute("data-other")).toBe("1")
    expect(target.getAttribute("data-added")).toBe("kept")
    expect(target.getAttribute("data-stays")).toBeNull()

    setLabel("two")
    expect(target.getAttribute("data-label")).toBe("two")
    expect(target.getAttribute("data-added")).toBe("kept")
  })

  it("records attribute mutations with oldValue, for props and for style and on*", () => {
    let target!: HostElement
    setup(() => <div ref={target} data-a="1" style={box} />)
    const observer = new MutationObserver(() => {})
    observer.observe(target as unknown as Node, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    target.setAttribute("data-a", "2")
    target.setAttribute("data-b", "x")
    target.setAttribute("tabindex", "0")
    target.setAttribute("style", "color: red")
    target.removeAttribute("data-b")
    target.toggleAttribute("inert")
    target.removeAttribute("data-never-set")
    const records = observer.takeRecords()
    expect(records.map((record) => [record.type, record.attributeName, record.oldValue])).toEqual([
      ["attributes", "data-a", "1"],
      ["attributes", "data-b", null],
      ["attributes", "tabindex", null],
      ["attributes", "style", "width: 40px; height: 20px;"],
      ["attributes", "data-b", "x"],
      ["attributes", "inert", null],
    ])
    expect(records.every((record) => record.target === (target as unknown as Node))).toBe(true)
  })
})
