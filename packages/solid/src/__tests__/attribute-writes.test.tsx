/** `setAttribute`, `removeAttribute` and `toggleAttribute` on a Solid element: the write has the effect of the prop. */
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { document, getComputedStyle } from "@ghia/native/host"
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

  describe("with a stylesheet", () => {
    const sheet = `
      [data-state="open"] { opacity: 0.25 }
      .marked { padding-top: 7px }
      [hidden] { padding-left: 5px }
    `

    it("applies and un-applies a rule keyed on an attribute written by setAttribute or dataset", () => {
      let target!: HostElement
      setup(() => (
        <div>
          <style>{sheet}</style>
          <div ref={target} style={box} />
        </div>
      ))
      expect(getComputedStyle(target).opacity).toBe("1")
      target.setAttribute("data-state", "open")
      expect(getComputedStyle(target).opacity).toBe("0.25")
      target.removeAttribute("data-state")
      expect(getComputedStyle(target).opacity).toBe("1")

      target.dataset.state = "open"
      expect(getComputedStyle(target).opacity).toBe("0.25")
      delete target.dataset.state
      expect(getComputedStyle(target).opacity).toBe("1")

      target.setAttribute("class", "marked")
      expect(getComputedStyle(target).paddingTop).toBe("7px")
      target.removeAttribute("class")
      expect(getComputedStyle(target).paddingTop).toBe("0px")

      expect(target.toggleAttribute("hidden")).toBe(true)
      expect(getComputedStyle(target).paddingLeft).toBe("5px")
      expect(target.toggleAttribute("hidden")).toBe(false)
      expect(getComputedStyle(target).paddingLeft).toBe("0px")
    })

    it("sends an attribute written before the first sheet exists once one does", () => {
      let target!: HostElement
      const [withSheet, setWithSheet] = createSignal(false)
      setup(() => (
        <div>
          <div ref={target} style={box} />
          {withSheet() ? <style>{sheet}</style> : null}
        </div>
      ))
      target.setAttribute("data-state", "open")
      setWithSheet(true)
      expect(getComputedStyle(target).opacity).toBe("0.25")
    })
  })

  it("makes the `checked` attribute of an input its default: a clean control follows it, a dirty one does not", () => {
    const nodes: Record<string, any> = {}
    setup(() => (
      <div>
        <input ref={(element: unknown) => (nodes.clean = element)} type="checkbox" style={box} />
        <input ref={(element: unknown) => (nodes.written = element)} type="checkbox" style={box} />
        <input ref={(element: unknown) => (nodes.clicked = element)} type="checkbox" style={box} />
      </div>
    ))
    const { clean, written, clicked } = nodes
    clean.setAttribute("checked", "")
    expect([clean.checked, clean.defaultChecked, clean.getAttribute("checked")]).toEqual([true, true, ""])
    expect(clean.getAttributeNames()).toContain("checked")
    clean.removeAttribute("checked")
    expect([clean.checked, clean.defaultChecked, clean.getAttribute("checked")]).toEqual([false, false, null])

    written.checked = false
    written.setAttribute("checked", "")
    expect([written.checked, written.defaultChecked, written.getAttribute("checked")]).toEqual([false, true, ""])

    clicked.click()
    expect(clicked.checked).toBe(true)
    clicked.removeAttribute("checked")
    expect([clicked.checked, clicked.getAttribute("checked")]).toEqual([true, null])
    clicked.setAttribute("checked", "")
    clicked.click()
    expect(clicked.checked).toBe(false)
  })

  it("makes the `value` attribute of a text input and a range its default value, and a checkbox's its value", () => {
    const nodes: Record<string, any> = {}
    const { renderer, idOf } = setup(() => (
      <div>
        <input ref={(element: unknown) => (nodes.text = element)} testId="text" type="text" style={{ width: 100, height: 20 }} />
        <input ref={(element: unknown) => (nodes.written = element)} type="text" style={{ width: 100, height: 20 }} />
        <input ref={(element: unknown) => (nodes.range = element)} type="range" style={{ width: 100, height: 20 }} />
        <input ref={(element: unknown) => (nodes.checkbox = element)} type="checkbox" style={box} />
        <textarea ref={(element: unknown) => (nodes.area = element)} style={{ width: 100, height: 40 }} />
      </div>
    ))
    const { text, written, range, checkbox, area } = nodes
    text.setAttribute("value", "a")
    expect([text.value, text.getAttribute("value")]).toEqual(["a", "a"])
    text.setAttribute("value", "b")
    expect(text.value).toBe("b")
    renderer.focusElement(idOf("text"))
    renderer.simulateKeystrokes("x")
    expect(text.value).toBe("bx")
    text.setAttribute("value", "c")
    expect([text.value, text.getAttribute("value")]).toEqual(["bx", "c"])

    written.value = "z"
    written.setAttribute("value", "c")
    expect([written.value, written.getAttribute("value")]).toEqual(["z", "c"])

    range.setAttribute("value", "20")
    expect([range.value, range.getAttribute("value")]).toEqual(["20", "20"])
    range.value = "30"
    range.setAttribute("value", "70")
    expect([range.value, range.getAttribute("value")]).toEqual(["30", "70"])

    // The value of a checkbox is its attribute, whether or not the control is dirty.
    expect(checkbox.value).toBe("on")
    checkbox.click()
    checkbox.setAttribute("value", "yes")
    expect([checkbox.value, checkbox.getAttribute("value")]).toEqual(["yes", "yes"])

    area.setAttribute("value", "t")
    expect([area.value, area.getAttribute("value")]).toEqual(["", "t"])
  })
  it("assigns the `checked` attribute through defaultChecked: getAttribute, selectors and observers see it, and an unmounted input takes it", () => {
    let element!: HostElement
    setup(() => <input ref={element} type="checkbox" style={box} />)
    const observer = new MutationObserver(() => {})
    observer.observe(element, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    const input = element as any
    input.defaultChecked = true
    expect([input.checked, input.getAttribute("checked"), input.matches("[checked]")]).toEqual([true, "", true])
    input.defaultChecked = false
    expect([input.checked, input.getAttribute("checked"), input.matches("[checked]")]).toEqual([false, null, false])
    expect(observer.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["checked", null],
      ["checked", ""],
    ])

    const created: any = document.createElement("input")
    created.defaultChecked = true
    expect([created.defaultChecked, created.getAttribute("checked")]).toEqual([true, ""])
  })

  it("has one answer for the checked attribute: the default, then the checked prop, in getAttribute and in a sheet", () => {
    let element!: HostElement
    const [checked, setChecked] = createSignal(false)
    setup(() => (
      <div>
        <style>{"[checked] { opacity: 0.25 }"}</style>
        <input ref={element} type="checkbox" checked={checked()} style={box} />
      </div>
    ))
    const target = element as any
    expect([target.getAttribute("checked"), getComputedStyle(target).opacity]).toEqual([null, "1"])
    target.setAttribute("checked", "")
    expect([target.getAttribute("checked"), getComputedStyle(target).opacity]).toEqual(["", "0.25"])
    setChecked(true)
    setChecked(false)
    expect([target.getAttribute("checked"), getComputedStyle(target).opacity]).toEqual(["", "0.25"])
    target.removeAttribute("checked")
    expect([target.getAttribute("checked"), getComputedStyle(target).opacity]).toEqual([null, "1"])
    setChecked(true)
    expect([target.getAttribute("checked"), getComputedStyle(target).opacity]).toEqual(["", "0.25"])
  })

  it("has one answer for the value attribute of a text input given a value, which a script's write to the attribute wins", () => {
    let element!: HostElement
    const [value, setValue] = createSignal("x")
    setup(() => (
      <div>
        <style>{'[value="y"] { opacity: 0.25 } [value="z"] { opacity: 0.5 }'}</style>
        <input ref={element} type="text" value={value()} style={{ width: 80, height: 20 }} />
      </div>
    ))
    const target = element as any
    expect(target.getAttribute("value")).toBe("x")
    target.setAttribute("value", "y")
    expect([target.getAttribute("value"), target.defaultValue, getComputedStyle(target).opacity]).toEqual(["y", "y", "0.25"])
    setValue("z")
    expect([target.value, target.getAttribute("value"), getComputedStyle(target).opacity]).toEqual(["z", "y", "0.25"])
    target.removeAttribute("value")
    expect([target.getAttribute("value"), getComputedStyle(target).opacity]).toEqual(["z", "0.5"])
  })

  it("has a defaultValue member that is the value attribute of an input and the default text of a textarea, and a number is its text", () => {
    const nodes: Record<string, any> = {}
    setup(() => (
      <div>
        <input ref={(element: unknown) => (nodes.text = element)} type="text" defaultValue={5} style={{ width: 80, height: 20 }} />
        <input ref={(element: unknown) => (nodes.plain = element)} type="text" style={{ width: 80, height: 20 }} />
        <textarea ref={(element: unknown) => (nodes.area = element)} style={{ width: 80, height: 40 }} />
        <div ref={(element: unknown) => (nodes.div = element)} />
      </div>
    ))
    expect([nodes.text.value, nodes.text.defaultValue, nodes.text.getAttribute("value")]).toEqual(["5", "5", "5"])
    expect([nodes.plain.defaultValue, nodes.plain.getAttribute("value")]).toEqual(["", null])
    nodes.plain.defaultValue = 7
    expect([nodes.plain.value, nodes.plain.defaultValue, nodes.plain.getAttribute("value")]).toEqual(["7", "7", "7"])
    nodes.area.defaultValue = "t"
    expect([nodes.area.value, nodes.area.defaultValue]).toEqual(["t", "t"])
    expect(nodes.div.defaultValue).toBeUndefined()
    const created: any = document.createElement("input")
    created.defaultValue = "c"
    expect([created.defaultValue, created.getAttribute("value")]).toEqual(["c", "c"])
  })
})
