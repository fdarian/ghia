/**
 * `<input type="checkbox">`, `<input type="radio">` and `<input type="hidden">`: the toggle, the
 * events around a click, radio groups, forms, selectors and accessibility, through the elements an
 * app renders. The Base UI test is how `@base-ui/react`'s Checkbox, Switch and Radio drive them.
 */
// @ts-nocheck

import React, { useState } from "react"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const box = { width: 20, height: 20 }

describeNative("checkbox, radio and hidden inputs", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  let log: string[]
  let nodes: Record<string, any>

  beforeEach(() => {
    testRoot = createTestRoot()
    log = []
    nodes = {}
  })

  const ref = (name: string) => (instance: unknown) => {
    if (instance) nodes[name] = instance
  }
  const renderer = () => testRoot.renderer
  const idOf = (testId: string) => renderer().findByTestId(testId).id
  const center = (testId: string) => {
    const bounds = renderer().getElementBounds(idOf(testId))
    return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
  }
  const click = (testId: string) => renderer().nativeSimulateClick(...center(testId))
  const press = (testId: string, keys: string) => renderer().nativeSimulateKeystrokes(idOf(testId), keys)
  const ariaNodes = () =>
    Object.values(renderer().getA11yTree().nodes ?? {})
      .map((node) => node.aria)
      .filter(Boolean)
  const nodeOf = (authorId: string) => ariaNodes().find((aria) => aria.author_id === authorId)
  const hasRole = (role: string) => ariaNodes().some((aria) => aria.role === role)
  const pointerClick = (init: object = {}) => new globalThis.PointerEvent("click", { bubbles: true, cancelable: true, ...init })
  const events = (name: string, node: () => any) => ({
    onClick: () => log.push(`${name}:click:${node().checked}`),
    onInput: () => log.push(`${name}:input:${node().checked}`),
    onChange: () => log.push(`${name}:change:${node().checked}`),
  })

  describe("the Base UI pattern", () => {
    function BaseUiCheckbox() {
      const [checked, setChecked] = useState(false)
      const input = React.useRef(null)
      return (
        <div style={{ width: 200, height: 60 }}>
          <span
            testId="root"
            role="checkbox"
            aria-checked={checked}
            style={{ display: "inline-block", width: 20, height: 20 }}
            onClick={(event) => {
              event.preventDefault()
              input.current.dispatchEvent(pointerClick())
            }}
          />
          <input
            ref={(node) => {
              input.current = node
              nodes.input = node
            }}
            testId="input"
            type="checkbox"
            checked={checked}
            tabIndex={-1}
            aria-hidden
            style={{ position: "absolute", width: 1, height: 1, margin: -1 }}
            onChange={(event) => {
              log.push(`onChange:${event.currentTarget.checked}`)
              setChecked(event.currentTarget.checked)
            }}
          />
        </div>
      )
    }

    it("a click on the span clicks the hidden input, whose onChange reads the new checked, and the controlled state follows", () => {
      testRoot.render(<BaseUiCheckbox />)
      expect(nodes.input.checked).toBe(false)
      click("root")
      expect(log).toEqual(["onChange:true"])
      expect(nodes.input.checked).toBe(true)
      click("root")
      expect(log).toEqual(["onChange:true", "onChange:false"])
      expect(nodes.input.checked).toBe(false)
    })

    it("a controlled input whose handler does not take the change goes back to its prop", () => {
      testRoot.render(
        <input ref={ref("input")} testId="input" type="checkbox" checked={false} onChange={() => log.push("change")} style={box} />,
      )
      click("input")
      expect(log).toEqual(["change"])
      expect(nodes.input.checked).toBe(false)
      click("input")
      expect(nodes.input.checked).toBe(false)
    })
  })

  describe("script writes and controlled restore", () => {
    it("a script-written checked is the control's state, so the user's clicks toggle it both ways", () => {
      testRoot.render(<input ref={ref("box")} testId="box" type="checkbox" style={box} />)
      nodes.box.checked = true
      click("box")
      expect(nodes.box.checked).toBe(false)
      click("box")
      expect(nodes.box.checked).toBe(true)
      nodes.box.checked = false
      click("box")
      expect(nodes.box.checked).toBe(true)
    })

    it("a script write to a radio unchecks its group and is no prop for a click to go back to", () => {
      testRoot.render(
        <div>
          <input ref={ref("a")} testId="a" type="radio" name="g" style={box} />
          <input ref={ref("b")} testId="b" type="radio" name="g" style={box} />
        </div>,
      )
      nodes.a.checked = true
      nodes.b.checked = true
      expect([nodes.a.checked, nodes.b.checked]).toEqual([false, true])
      click("a")
      expect([nodes.a.checked, nodes.b.checked]).toEqual([true, false])
    })

    it("an uncontrolled checkbox the Base UI way keeps what the user chose and fires its handlers", () => {
      testRoot.render(<input ref={ref("box")} testId="box" type="checkbox" defaultChecked style={box} {...events("box", () => nodes.box)} />)
      click("box")
      expect(nodes.box.checked).toBe(false)
      expect(log).toEqual(["box:click:false", "box:input:false", "box:change:false"])
    })

    it("a controlled checkbox with no handler at all goes back to its prop, as in React DOM", () => {
      testRoot.render(<input ref={ref("box")} testId="box" type="checkbox" checked={false} readOnly style={box} />)
      click("box")
      expect(nodes.box.checked).toBe(false)
    })

    it("goes back to its prop after the handlers, not before: they read the new checked", () => {
      testRoot.render(
        <input
          ref={ref("box")}
          testId="box"
          type="checkbox"
          checked={false}
          style={box}
          onInput={() => log.push(`input:${nodes.box.checked}`)}
          onChange={(event) => log.push(`change:${event.currentTarget.checked}`)}
        />,
      )
      click("box")
      expect(log).toEqual(["input:true", "change:true"])
      expect(nodes.box.checked).toBe(false)
    })

    it("a script write to a controlled checkbox stays until the next user event restores the prop", () => {
      testRoot.render(<input ref={ref("box")} testId="box" type="checkbox" checked={false} onChange={() => log.push("change")} style={box} />)
      nodes.box.checked = true
      expect(nodes.box.checked).toBe(true)
      click("box")
      expect(nodes.box.checked).toBe(false)
    })

    it("a controlled checkbox follows the state a handler stores and a canceled click restores nothing", () => {
      function Switch() {
        const [on, setOn] = useState(false)
        return <input ref={ref("box")} testId="box" type="checkbox" checked={on} onChange={(event) => setOn(event.currentTarget.checked)} style={box} />
      }
      testRoot.render(<Switch />)
      click("box")
      expect(nodes.box.checked).toBe(true)
      click("box")
      expect(nodes.box.checked).toBe(false)
    })
  })

  describe("activation", () => {
    function mountCheckbox(props: object = {}) {
      testRoot.render(
        <input ref={ref("box")} testId="box" type="checkbox" style={box} {...events("box", () => nodes.box)} {...props} />,
      )
    }

    it("a pointer click toggles before the listeners, then fires input and change", () => {
      mountCheckbox()
      click("box")
      expect(log).toEqual(["box:click:true", "box:input:true", "box:change:true"])
      click("box")
      expect(nodes.box.checked).toBe(false)
    })

    it("Space on a focused checkbox toggles it on key up, and Enter does not", () => {
      mountCheckbox()
      press("box", "Enter")
      expect(log).toEqual([])
      press("box", "Space")
      expect(log).toEqual(["box:click:true", "box:input:true", "box:change:true"])
    })

    it("click() toggles it", () => {
      mountCheckbox()
      nodes.box.click()
      expect(log).toEqual(["box:click:true", "box:input:true", "box:change:true"])
    })

    it("a dispatched click toggles it, and a click that is not a MouseEvent does not", () => {
      mountCheckbox()
      nodes.box.dispatchEvent(pointerClick())
      expect(nodes.box.checked).toBe(true)
      nodes.box.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }))
      expect(nodes.box.checked).toBe(true)
    })

    it("a canceled click puts the checkbox back and fires nothing after it", () => {
      mountCheckbox({
        onClick: (event) => {
          log.push(`click:${nodes.box.checked}`)
          event.preventDefault()
        },
      })
      click("box")
      nodes.box.click()
      nodes.box.dispatchEvent(pointerClick())
      expect(log).toEqual(["click:true", "click:true", "click:true"])
      expect(nodes.box.checked).toBe(false)
    })

    it("a disabled checkbox does nothing", () => {
      mountCheckbox({ disabled: true })
      click("box")
      nodes.box.click()
      expect(log).toEqual([])
      expect(nodes.box.checked).toBe(false)
    })

    it("input and change bubble and cannot be canceled", () => {
      testRoot.render(
        <div
          onInput={(event) => log.push(`wrapper:input:${event.cancelable}:${event.bubbles}`)}
          onChange={(event) => log.push(`wrapper:change:${event.cancelable}`)}
        >
          <input testId="box" type="checkbox" style={box} />
        </div>,
      )
      click("box")
      expect(log).toEqual(["wrapper:input:false:true", "wrapper:change:false"])
    })

    it("addEventListener hears click, input and change, each once", () => {
      mountCheckbox({ onClick: undefined, onInput: undefined, onChange: undefined })
      for (const type of ["click", "input", "change"]) {
        nodes.box.addEventListener(type, () => log.push(`${type}:${nodes.box.checked}`))
      }
      click("box")
      expect(log).toEqual(["click:true", "input:true", "change:true"])
    })

    it("a user's toggle clears indeterminate, and a canceled one leaves it", () => {
      mountCheckbox({
        onClick: (event) => {
          if (nodes.cancel) event.preventDefault()
        },
      })
      nodes.box.indeterminate = true
      expect(nodes.box.indeterminate).toBe(true)
      nodes.cancel = true
      click("box")
      expect(nodes.box.indeterminate).toBe(true)
      expect(nodes.box.checked).toBe(false)
      nodes.cancel = false
      click("box")
      expect(nodes.box.indeterminate).toBe(false)
      expect(nodes.box.checked).toBe(true)
    })

    it("a label toggles its checkbox once, whether it names it or wraps it", () => {
      testRoot.render(
        <div style={{ width: 300, height: 100 }}>
          <label testId="named" htmlFor="a" style={{ width: 80, height: 20 }}>
            A
          </label>
          <input ref={ref("a")} id="a" type="checkbox" style={box} {...events("a", () => nodes.a)} />
          <label testId="wrapping" style={{ width: 80, height: 20 }}>
            B
            <input ref={ref("b")} type="checkbox" style={box} {...events("b", () => nodes.b)} />
          </label>
        </div>,
      )
      click("named")
      expect(log).toEqual(["a:click:true", "a:input:true", "a:change:true"])
      log.length = 0
      click("wrapping")
      expect(log).toEqual(["b:click:true", "b:input:true", "b:change:true"])
      expect(nodes.a.checked && nodes.b.checked).toBe(true)
    })
  })

  describe("state", () => {
    it("defaultChecked is the checkedness until a write makes it dirty", () => {
      testRoot.render(<input ref={ref("box")} type="checkbox" defaultChecked style={box} />)
      expect(nodes.box.checked).toBe(true)
      expect(nodes.box.defaultChecked).toBe(true)
      testRoot.render(<input ref={ref("box")} type="checkbox" defaultChecked={false} style={box} />)
      expect(nodes.box.checked).toBe(false)
      nodes.box.checked = true
      testRoot.render(<input ref={ref("box")} type="checkbox" defaultChecked={true} style={box} />)
      testRoot.render(<input ref={ref("box")} type="checkbox" defaultChecked={false} style={box} />)
      expect(nodes.box.checked).toBe(true)
      expect(nodes.box.defaultChecked).toBe(false)
    })

    it("a user's toggle makes it dirty", () => {
      testRoot.render(<input ref={ref("box")} testId="box" type="checkbox" defaultChecked={false} style={box} />)
      click("box")
      testRoot.render(<input ref={ref("box")} testId="box" type="checkbox" defaultChecked={true} style={box} />)
      testRoot.render(<input ref={ref("box")} testId="box" type="checkbox" defaultChecked={false} style={box} />)
      expect(nodes.box.checked).toBe(true)
    })

    it("value defaults to on for a checkbox and a radio, and to nothing for a hidden input", () => {
      testRoot.render(
        <div>
          <input ref={ref("box")} type="checkbox" />
          <input ref={ref("radio")} type="radio" value="x" />
          <input ref={ref("hidden")} type="hidden" />
        </div>,
      )
      expect([nodes.box.value, nodes.radio.value, nodes.hidden.value]).toEqual(["on", "x", ""])
      nodes.box.value = "yes"
      expect(nodes.box.value).toBe("yes")
    })

    it("a text input reads its text through value", () => {
      testRoot.render(<input ref={ref("text")} value="hello" onChange={() => {}} style={{ width: 100, height: 20 }} />)
      expect(nodes.text.value).toBe("hello")
      expect(nodes.text.checked).toBe(false)
    })

    it("another element has no such members and takes a plain property", () => {
      testRoot.render(<div ref={ref("div")} />)
      expect(nodes.div.checked).toBeUndefined()
      nodes.div.value = 3
      expect(nodes.div.value).toBe(3)
    })

    it("a change of type builds the control again", () => {
      function Switching({ type }) {
        return <input ref={ref("input")} testId="input" type={type} defaultChecked style={box} />
      }
      testRoot.render(<Switching type="text" />)
      testRoot.render(<Switching type="checkbox" />)
      expect(nodes.input.checked).toBe(true)
      expect(hasRole("CheckBox")).toBe(true)
      testRoot.render(<Switching type="text" />)
      expect(hasRole("CheckBox")).toBe(false)
    })
  })

  describe("radio groups", () => {
    const radio = (name: string, group: string, props: object = {}) => (
      <input
        ref={ref(name)}
        testId={name}
        type="radio"
        name={group}
        style={box}
        {...events(name, () => nodes[name])}
        {...props}
      />
    )

    it("checking one unchecks the others of its name in the same form, and not another form's", () => {
      testRoot.render(
        <div>
          <form>
            {radio("a", "g")}
            {radio("b", "g")}
            {radio("other", "other")}
          </form>
          <form>{radio("c", "g")}</form>
        </div>,
      )
      click("a")
      click("c")
      expect([nodes.a.checked, nodes.b.checked, nodes.c.checked]).toEqual([true, false, true])
      log.length = 0
      click("b")
      expect([nodes.a.checked, nodes.b.checked, nodes.c.checked]).toEqual([false, true, true])
      expect(log).toEqual(["b:click:true", "b:input:true", "b:change:true"])
    })

    it("without a form the group is the radios of the same name in the tree", () => {
      testRoot.render(
        <div>
          {radio("a", "g")}
          <div>{radio("b", "g")}</div>
          {radio("c", "")}
          {radio("d", "")}
        </div>,
      )
      click("a")
      click("b")
      expect([nodes.a.checked, nodes.b.checked]).toEqual([false, true])
      click("c")
      click("d")
      expect([nodes.c.checked, nodes.d.checked]).toEqual([true, true])
    })

    it("a click on the radio that is checked fires nothing", () => {
      testRoot.render(<div>{radio("a", "g", { defaultChecked: true })}</div>)
      click("a")
      expect(log).toEqual(["a:click:true"])
    })

    it("a canceled radio click checks the previous radio again", () => {
      testRoot.render(
        <div>
          {radio("a", "g", { defaultChecked: true })}
          {radio("b", "g", { onClick: (event) => event.preventDefault() })}
        </div>,
      )
      click("b")
      expect([nodes.a.checked, nodes.b.checked]).toEqual([true, false])
    })

    it("a controlled group shows its props whatever the user clicked", () => {
      function Group() {
        const [value, setValue] = useState("a")
        return (
          <div>
            {["a", "b"].map((name) => (
              <input
                key={name}
                ref={ref(name)}
                testId={name}
                type="radio"
                name="g"
                checked={value === name}
                onChange={() => name !== "b" && setValue(name)}
                style={box}
              />
            ))}
          </div>
        )
      }
      testRoot.render(<Group />)
      click("b")
      expect([nodes.a.checked, nodes.b.checked]).toEqual([true, false])
    })
  })

  describe("forms", () => {
    const submitted = () => {
      const entries: string[][][] = []
      return {
        entries,
        onSubmit: (event) => entries.push(Array.from(event.formData.entries())),
      }
    }

    it("submits a checkbox and a radio only when checked, under their value, and a hidden input always", () => {
      const submits = submitted()
      testRoot.render(
        <form ref={ref("form")} onSubmit={submits.onSubmit} style={{ width: 300, height: 100 }}>
          <input type="hidden" name="h" value="secret" />
          <input testId="c1" type="checkbox" name="c1" style={box} />
          <input testId="c2" type="checkbox" name="c2" value="yes" defaultChecked style={box} />
          <input testId="r1" type="radio" name="r" value="one" style={box} />
          <input testId="r2" type="radio" name="r" value="two" defaultChecked style={box} />
          <input type="checkbox" value="nameless" defaultChecked />
          <input type="checkbox" name="off" disabled defaultChecked />
        </form>,
      )
      nodes.form.requestSubmit()
      expect(submits.entries.pop()).toEqual([
        ["h", "secret"],
        ["c2", "yes"],
        ["r", "two"],
      ])
      click("c1")
      click("r1")
      nodes.form.requestSubmit()
      expect(submits.entries.pop()).toEqual([
        ["h", "secret"],
        ["c1", "on"],
        ["c2", "yes"],
        ["r", "one"],
      ])
    })

    it("a Base UI checkbox submits its unchecked value through the hidden input before it, and its own value once checked", () => {
      const submits = submitted()
      testRoot.render(
        <form ref={ref("form")} onSubmit={submits.onSubmit}>
          <input type="hidden" name="terms" value="off" />
          <input testId="terms" type="checkbox" name="terms" value="on" style={box} />
        </form>,
      )
      nodes.form.requestSubmit()
      expect(submits.entries.pop()).toEqual([["terms", "off"]])
      click("terms")
      nodes.form.requestSubmit()
      expect(submits.entries.pop()).toEqual([
        ["terms", "off"],
        ["terms", "on"],
      ])
    })

    it("a required checkbox blocks the submission until it is checked", () => {
      const submits = submitted()
      testRoot.render(
        <form ref={ref("form")} onSubmit={submits.onSubmit}>
          <input testId="terms" type="checkbox" required onInvalid={() => log.push("invalid")} style={box} />
        </form>,
      )
      nodes.form.requestSubmit()
      expect(log).toEqual(["invalid"])
      expect(submits.entries).toEqual([])
      click("terms")
      nodes.form.requestSubmit()
      expect(submits.entries).toHaveLength(1)
    })

    it("Enter in a text field submits when the only other controls are checkboxes, radios and hidden inputs", () => {
      const submits = submitted()
      testRoot.render(
        <form onSubmit={submits.onSubmit}>
          <input testId="text" name="t" style={{ width: 100, height: 20 }} />
          <input type="checkbox" />
          <input type="radio" />
          <input type="hidden" name="h" value="x" />
        </form>,
      )
      press("text", "Enter")
      expect(submits.entries).toEqual([[["t", ""], ["h", "x"]]])
    })
  })

  describe("selectors", () => {
    it(":checked and :indeterminate read the live state", () => {
      testRoot.render(
        <div ref={ref("root")}>
          <input testId="a" type="checkbox" style={box} />
          <input testId="b" type="radio" defaultChecked style={box} />
          <input ref={ref("text")} />
        </div>,
      )
      const checked = () => Array.from(nodes.root.querySelectorAll(":checked")).length
      expect(checked()).toBe(1)
      click("a")
      expect(checked()).toBe(2)
      expect(nodes.root.querySelector("input:checked[type=checkbox]")).not.toBeNull()
      expect(nodes.root.querySelectorAll(":indeterminate")).toHaveLength(0)
      nodes.root.querySelector("[type=checkbox]").indeterminate = true
      expect(nodes.root.querySelectorAll(":indeterminate")).toHaveLength(1)
      expect(nodes.text.matches(":checked")).toBe(false)
    })
  })

  describe("accessibility, focus and layout", () => {
    it("a checkbox and a radio have their role and toggled state, mixed when indeterminate", () => {
      testRoot.render(
        <div>
          <input id="c" type="checkbox" style={box} />
          <input id="r" type="radio" defaultChecked style={box} />
        </div>,
      )
      expect(nodeOf("c")).toEqual(expect.objectContaining({ role: "CheckBox", toggled: "False" }))
      expect(nodeOf("r")).toEqual(expect.objectContaining({ role: "RadioButton", toggled: "True" }))
    })

    it("the node follows a toggle and an indeterminate write", () => {
      testRoot.render(<input ref={ref("c")} id="c" testId="c" type="checkbox" style={box} />)
      click("c")
      expect(nodeOf("c").toggled).toBe("True")
      nodes.c.indeterminate = true
      expect(nodeOf("c").toggled).toBe("Mixed")
    })

    it("an explicit aria-checked wins", () => {
      testRoot.render(<input id="c" type="checkbox" aria-checked="mixed" style={box} />)
      expect(nodeOf("c").toggled).toBe("Mixed")
    })

    it("is a tab stop unless disabled, and Tab reaches it", () => {
      testRoot.render(
        <div>
          <input testId="a" type="checkbox" style={box} />
          <input testId="b" type="checkbox" disabled style={box} />
          <input testId="c" type="radio" style={box} />
        </div>,
      )
      renderer().native.focusNext()
      expect(renderer().getFocusedElementId()).toBe(idOf("a"))
      renderer().native.focusNext()
      expect(renderer().getFocusedElementId()).toBe(idOf("c"))
    })

    it("has the size and margin of a browser's checkbox and radio, and is inline", () => {
      testRoot.render(
        <div style={{ width: 200 }}>
          <input testId="c" type="checkbox" />
          <input testId="r" type="radio" />
        </div>,
      )
      const c = renderer().getElementBounds(idOf("c"))
      const r = renderer().getElementBounds(idOf("r"))
      expect([c.width, c.height, r.width, r.height]).toEqual([13, 13, 13, 13])
      expect(r.x - (c.x + c.width)).toBe(3 + 5)
      expect(c.x).toBeGreaterThanOrEqual(4)
    })

    it("a hidden input has no box and no focus, and is no node", () => {
      testRoot.render(
        <div>
          <input ref={ref("h")} testId="h" id="h" type="hidden" name="h" value="x" />
          <input testId="a" type="checkbox" style={box} />
        </div>,
      )
      const bounds = renderer().getElementBounds(idOf("h"))
      expect(!bounds || bounds.width * bounds.height === 0).toBe(true)
      nodes.h.focus()
      expect(renderer().getFocusedElementId()).not.toBe(idOf("h"))
      renderer().native.focusNext()
      expect(renderer().getFocusedElementId()).toBe(idOf("a"))
      expect(nodeOf("h")).toBeUndefined()
    })

    it("a click on a checkbox does not match :focus-visible, a key does", () => {
      testRoot.render(<input ref={ref("c")} testId="c" type="checkbox" style={box} />)
      click("c")
      expect(nodes.c.matches(":focus")).toBe(true)
      expect(nodes.c.matches(":focus-visible")).toBe(false)
    })
  })
})
