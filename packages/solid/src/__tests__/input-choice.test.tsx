/**
 * `<input type="checkbox">`, `<input type="radio">` and `<input type="hidden">` in Solid: the toggle,
 * the events around a click, radio groups, forms, selectors and accessibility.
 */
// @ts-nocheck

import { createSignal } from "solid-js"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const box = { width: 20, height: 20 }

describe.skipIf(!hasNativeTestRenderer)("Solid checkbox, radio and hidden inputs", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  let log: string[]
  let nodes: Record<string, any>

  beforeEach(() => {
    testRoot = createTestRoot({ width: 400, height: 400 })
    log = []
    nodes = {}
  })

  const ref = (name: string) => (node: unknown) => {
    nodes[name] = node
  }
  const renderer = () => testRoot.renderer
  const idOf = (testId: string) => renderer().findByTestId(testId).id
  const center = (testId: string) => {
    const bounds = renderer().getElementBounds(idOf(testId))
    return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
  }
  const click = (testId: string) => renderer().nativeSimulateClick(...center(testId))
  const press = (testId: string, keys: string) => renderer().nativeSimulateKeystrokes(idOf(testId), keys)
  const pointerClick = (init: object = {}) => new globalThis.PointerEvent("click", { bubbles: true, cancelable: true, ...init })
  const events = (name: string) => ({
    onClick: () => log.push(`${name}:click:${nodes[name].checked}`),
    onInput: () => log.push(`${name}:input:${nodes[name].checked}`),
    onChange: () => log.push(`${name}:change:${nodes[name].checked}`),
  })
  const ariaNodes = () =>
    Object.values(renderer().getA11yTree().nodes ?? {})
      .map((node) => node.aria)
      .filter(Boolean)
  const nodeOf = (authorId: string) => ariaNodes().find((aria) => aria.author_id === authorId)
  const hasRole = (role: string) => ariaNodes().some((aria) => aria.role === role)

  it("drives a Base UI checkbox: a click on the span clicks the hidden input, whose change handler reads the new checked", () => {
    testRoot.render(() => {
      const [checked, setChecked] = createSignal(false)
      return (
        <div style={{ width: 200, height: 60 }}>
          <span
            testId="root"
            role="checkbox"
            style={{ display: "inline-block", width: 20, height: 20 }}
            onClick={(event) => {
              event.preventDefault()
              nodes.input.dispatchEvent(pointerClick())
            }}
          />
          <input
            ref={ref("input")}
            type="checkbox"
            checked={checked()}
            onChange={(event) => {
              log.push(`change:${event.currentTarget.checked}`)
              setChecked(event.currentTarget.checked)
            }}
            style={{ position: "absolute", width: 1, height: 1 }}
          />
        </div>
      )
    })
    click("root")
    expect(log).toEqual(["change:true"])
    expect(nodes.input.checked).toBe(true)
    click("root")
    expect(log).toEqual(["change:true", "change:false"])
    expect(nodes.input.checked).toBe(false)
  })

  it("onInput and onChange both fire once, after the click listeners, with the new checked", () => {
    testRoot.render(() => <input ref={ref("box")} testId="box" type="checkbox" style={box} {...events("box")} />)
    click("box")
    expect(log).toEqual(["box:click:true", "box:input:true", "box:change:true"])
  })

  it("toggles with Space and click(), but not with Enter", () => {
    testRoot.render(() => <input ref={ref("box")} testId="box" type="checkbox" style={box} {...events("box")} />)
    press("box", "Enter")
    expect(log).toEqual([])
    press("box", "Space")
    expect(nodes.box.checked).toBe(true)
    nodes.box.click()
    expect(nodes.box.checked).toBe(false)
    expect(log).toHaveLength(6)
  })

  it("puts a canceled click back, and does nothing when disabled", () => {
    testRoot.render(() => (
      <div>
        <input ref={ref("box")} testId="box" type="checkbox" style={box} onClick={(event) => event.preventDefault()} onChange={() => log.push("change")} />
        <input ref={ref("off")} testId="off" type="checkbox" disabled style={box} onChange={() => log.push("off")} />
      </div>
    ))
    click("box")
    nodes.box.click()
    nodes.box.dispatchEvent(pointerClick())
    nodes.off.click()
    expect(nodes.box.checked).toBe(false)
    expect(log).toEqual([])
  })

  it("a controlled input whose handler does not take the change goes back to its prop", () => {
    testRoot.render(() => <input ref={ref("box")} testId="box" type="checkbox" checked={false} onChange={() => log.push("change")} style={box} />)
    click("box")
    expect(log).toEqual(["change"])
    expect(nodes.box.checked).toBe(false)
  })

  it("clears indeterminate on a user's toggle", () => {
    testRoot.render(() => <input ref={ref("box")} testId="box" type="checkbox" style={box} />)
    nodes.box.indeterminate = true
    expect(nodes.box.indeterminate).toBe(true)
    click("box")
    expect(nodes.box.indeterminate).toBe(false)
  })

  it("defaultChecked is the checkedness until a write or a toggle makes it dirty", () => {
    const [initial, setInitial] = createSignal(true)
    testRoot.render(() => (
      <div>
        <input ref={ref("a")} type="checkbox" defaultChecked={initial()} style={box} />
        <input ref={ref("b")} testId="b" type="checkbox" defaultChecked={initial()} style={box} />
      </div>
    ))
    expect([nodes.a.checked, nodes.a.defaultChecked]).toEqual([true, true])
    click("b")
    nodes.a.checked = true
    setInitial(false)
    testRoot.renderer.flush()
    expect([nodes.a.checked, nodes.a.defaultChecked]).toEqual([true, false])
    expect(nodes.b.checked).toBe(false)
  })

  it("has a value that defaults to on", () => {
    testRoot.render(() => (
      <div>
        <input ref={ref("box")} type="checkbox" />
        <input ref={ref("hidden")} type="hidden" value="x" />
        <input ref={ref("text")} value="typed" style={{ width: 100, height: 20 }} />
      </div>
    ))
    expect([nodes.box.value, nodes.hidden.value, nodes.text.value]).toEqual(["on", "x", "typed"])
  })

  it("checks one radio of a group and unchecks the others in its form and in a tree with none", () => {
    const radio = (name: string, group: string) => (
      <input ref={ref(name)} testId={name} type="radio" name={group} style={box} {...events(name)} />
    )
    testRoot.render(() => (
      <div>
        <form>
          {radio("a", "g")}
          {radio("b", "g")}
        </form>
        <form>{radio("c", "g")}</form>
        {radio("d", "h")}
        {radio("e", "h")}
      </div>
    ))
    click("a")
    click("c")
    click("b")
    expect([nodes.a.checked, nodes.b.checked, nodes.c.checked]).toEqual([false, true, true])
    click("d")
    click("e")
    expect([nodes.d.checked, nodes.e.checked]).toEqual([false, true])
  })

  it("a label toggles its checkbox once", () => {
    testRoot.render(() => (
      <div style={{ width: 300, height: 100 }}>
        <label testId="label" htmlFor="a" style={{ width: 80, height: 20 }}>
          A
        </label>
        <input ref={ref("a")} id="a" type="checkbox" style={box} {...events("a")} />
      </div>
    ))
    click("label")
    expect(log).toEqual(["a:click:true", "a:input:true", "a:change:true"])
  })

  it("submits checked choices under their value and hidden inputs always, in tree order", () => {
    const entries: string[][][] = []
    testRoot.render(() => (
      <form ref={ref("form")} onSubmit={(event) => entries.push(Array.from(event.formData.entries()))}>
        <input type="hidden" name="terms" value="off" />
        <input testId="terms" type="checkbox" name="terms" style={box} />
        <input type="radio" name="r" value="one" style={box} />
        <input type="radio" name="r" value="two" defaultChecked style={box} />
      </form>
    ))
    nodes.form.requestSubmit()
    expect(entries.pop()).toEqual([["terms", "off"], ["r", "two"]])
    click("terms")
    nodes.form.requestSubmit()
    expect(entries.pop()).toEqual([["terms", "off"], ["terms", "on"], ["r", "two"]])
  })

  it(":checked and :indeterminate read the live state", () => {
    testRoot.render(() => (
      <div ref={ref("root")}>
        <input testId="a" type="checkbox" style={box} />
        <input type="radio" defaultChecked style={box} />
      </div>
    ))
    expect(nodes.root.querySelectorAll(":checked")).toHaveLength(1)
    click("a")
    expect(nodes.root.querySelectorAll(":checked")).toHaveLength(2)
    nodes.root.querySelector("[type=checkbox]").indeterminate = true
    expect(nodes.root.querySelectorAll(":indeterminate")).toHaveLength(1)
  })

  it("reports its role and toggled state, mixed when indeterminate", () => {
    testRoot.render(() => (
      <div>
        <input ref={ref("c")} id="c" testId="c" type="checkbox" style={box} />
        <input id="r" type="radio" defaultChecked style={box} />
      </div>
    ))
    expect(nodeOf("c")).toEqual(expect.objectContaining({ role: "CheckBox", toggled: "False" }))
    expect(nodeOf("r")).toEqual(expect.objectContaining({ role: "RadioButton", toggled: "True" }))
    click("c")
    expect(nodeOf("c").toggled).toBe("True")
    nodes.c.indeterminate = true
    expect(nodeOf("c").toggled).toBe("Mixed")
  })

  it("a hidden input has no box and no focus, and a disabled checkbox is no tab stop", () => {
    testRoot.render(() => (
      <div>
        <input ref={ref("h")} testId="h" type="hidden" />
        <input testId="off" type="checkbox" disabled style={box} />
        <input testId="a" type="checkbox" style={box} />
      </div>
    ))
    const bounds = renderer().getElementBounds(idOf("h"))
    expect(!bounds || bounds.width * bounds.height === 0).toBe(true)
    nodes.h.focus()
    expect(renderer().getFocusedElementId()).not.toBe(idOf("h"))
    renderer().native.focusNext()
    expect(renderer().getFocusedElementId()).toBe(idOf("a"))
  })

  it("switches control when type changes", () => {
    const [type, setType] = createSignal("text")
    testRoot.render(() => <input ref={ref("i")} type={type()} defaultChecked style={box} />)
    setType("checkbox")
    renderer().flush()
    expect(nodes.i.checked).toBe(true)
    expect(hasRole("CheckBox")).toBe(true)
  })
})
