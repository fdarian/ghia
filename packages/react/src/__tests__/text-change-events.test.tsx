/** `input` per edit and `change` on commit of an <input> and <textarea>, as React DOM and the DOM fire them. */
// @ts-nocheck

import React, { useState } from "react"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const box = { width: 200, height: 30 }

describeNative("input and change events of text controls, in React", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  let log: string[]
  let field: any
  let other: any
  let checkbox: any

  beforeEach(() => {
    testRoot = createTestRoot()
    log = []
  })

  const id = (testId = "field") => testRoot.renderer.findByTestId(testId).id
  const press = (keys: string, testId = "field") => testRoot.renderer.nativeSimulateKeystrokes(id(testId), keys)
  const listening = new WeakSet<object>()
  const listen = (node: any) => {
    field = node
    if (listening.has(node)) return
    listening.add(node)
    for (const type of ["input", "change", "blur"]) node.addEventListener(type, (event) => log.push(type))
  }

  function mount(Tag: "input" | "textarea" = "input", props = {}) {
    testRoot.render(
      <div style={{ width: 400, height: 200 }}>
        <Tag testId="field" ref={(node) => node && listen(node)} style={{ ...box, height: 60 }} {...props} />
        <input testId="other" ref={(node) => node && (other = node)} style={box} />
      </div>,
    )
  }

  it("onChange and onInput each fire once per keystroke, onInput first", () => {
    mount("input", {
      onInput: () => log.push("onInput"),
      onChange: (event) => log.push(`onChange ${event.value}`),
    })
    press("a b")
    expect(log.filter((entry) => entry.startsWith("on"))).toEqual(["onInput", "onChange a", "onInput", "onChange ab"])
  })

  it("onChange alone fires per keystroke, as in React DOM", () => {
    mount("textarea", { onChange: (event) => log.push(event.value) })
    press("a b Enter")
    expect(log.filter((entry) => !["input", "change", "blur"].includes(entry))).toEqual(["a", "ab", "ab\n"])
  })

  it("a controlled input keeps what the handler stores", () => {
    function Controlled() {
      const [text, setText] = useState("")
      return <input testId="field" ref={(node) => node && listen(node)} value={text} style={box} onChange={(event) => setText(event.value.toUpperCase())} />
    }
    testRoot.render(<Controlled />)
    press("a b")
    expect(field.value).toBe("AB")
  })

  it("input bubbles to an ancestor, and a div's onChange hears the edits of the text controls below it", () => {
    const heard: string[] = []
    testRoot.render(
      <div
        style={{ width: 400, height: 200 }}
        onInput={(event) => heard.push(`onInput ${event.target.props.type ?? "text"}`)}
        onChange={(event) => heard.push(`onChange ${event.target.props.type ?? "text"}`)}
      >
        <input testId="field" style={box} />
        <input testId="box" type="checkbox" ref={(node) => node && (checkbox = node)} style={{ width: 13, height: 13 }} />
      </div>,
    )
    press("a b")
    expect(heard).toEqual(["onInput text", "onChange text", "onInput text", "onChange text"])
    heard.length = 0
    checkbox.click()
    expect(heard).toEqual(["onInput checkbox", "onChange checkbox"])
  })

  it("onChange of a checkbox is its change event, and moves with its type", () => {
    function Switch({ type }) {
      return <input testId="field" type={type} style={box} onChange={() => log.push("onChange")} ref={(node) => node && (field = node)} />
    }
    testRoot.render(<Switch type="checkbox" />)
    field.click()
    expect(log).toEqual(["onChange"])
    log.length = 0
    testRoot.render(<Switch type="text" />)
    press("a")
    expect(log).toEqual(["onChange"])
    log.length = 0
    testRoot.render(<Switch type="checkbox" />)
    field.click()
    expect(log).toEqual(["onChange"])
  })

  describe("the change event", () => {
    beforeEach(() => mount())

    it("fires on blur after an edit, before the blur, and carries the value", () => {
      const values: unknown[] = []
      field.addEventListener("change", (event) => values.push(event.value))
      field.focus()
      press("a b")
      expect(log).toEqual(["input", "input"])
      field.blur()
      expect(log).toEqual(["input", "input", "change", "blur"])
      expect(values).toEqual(["ab"])
    })

    it("does not fire on blur without an edit", () => {
      field.focus()
      field.blur()
      expect(log).toEqual(["blur"])
    })

    it("does not fire for an edit that was undone, nor again on the next blur", () => {
      field.focus()
      press("a Backspace")
      field.blur()
      expect(log).toEqual(["input", "input", "blur"])
      log.length = 0
      field.focus()
      press("b")
      field.blur()
      field.focus()
      field.blur()
      expect(log).toEqual(["input", "change", "blur", "blur"])
    })

    it("measures the next edit from the last commit", () => {
      field.focus()
      press("a")
      field.blur()
      field.focus()
      press("b Backspace")
      log.length = 0
      field.blur()
      expect(log).toEqual(["blur"])
    })

    it("does not fire for a write to value, which also drops an edit not yet committed", () => {
      field.focus()
      field.value = "x"
      field.blur()
      expect(log).toEqual(["blur"])
      log.length = 0
      field.focus()
      press("y")
      field.value = "z"
      field.blur()
      expect(log).toEqual(["input", "blur"])
    })

    it("fires on Enter in an <input>, before the submit of its form", () => {
      const order: string[] = []
      testRoot.render(
        <form testId="form" onSubmit={() => order.push("submit")}>
          <input testId="field" ref={(node) => node && listen(node)} style={box} onKeyDown={(event) => order.push(event.key)} />
        </form>,
      )
      field.addEventListener("change", () => order.push("change"))
      press("a")
      press("Enter")
      expect(order).toEqual(["a", "Enter", "change", "submit"])
      order.length = 0
      press("Enter")
      expect(order).toEqual(["Enter", "submit"])
    })

    it("fires on Enter in an <input> with no form, and not again on blur", () => {
      field.focus()
      press("a")
      press("Enter")
      expect(log).toEqual(["input", "change"])
      field.blur()
      expect(log).toEqual(["input", "change", "blur"])
    })

    it("does not fire on Enter when keydown was prevented", () => {
      mount("input", { onKeyDown: (event) => event.preventDefault() })
      field.focus()
      press("a")
      log.length = 0
      press("Enter")
      expect(log).toEqual([])
    })

    it("Enter in a <textarea> inserts a newline and fires input, not change", () => {
      mount("textarea")
      field.focus()
      press("a")
      press("Enter")
      expect(field.value).toBe("a\n")
      expect(log).toEqual(["input", "input"])
      field.blur()
      expect(log).toEqual(["input", "input", "change", "blur"])
    })

    it("fires when focus moves to another control, not for a control that never had focus", () => {
      field.focus()
      press("a")
      other.focus()
      expect(log).toEqual(["input", "change", "blur"])
    })
  })

  describe("edits that fire input", () => {
    beforeEach(() => mount())

    it("a number input's arrow step fires input, with an empty inputType, and commits", () => {
      mount("input", { type: "number", value: "1", onChange: () => {} })
      const types: unknown[] = []
      field.addEventListener("input", (event) => types.push(event.inputType))
      press("ArrowUp ArrowUp")
      expect(types).toEqual(["", ""])
      expect(log).toEqual(["input", "change", "input", "change"])
    })

    it("an input method's commit fires one input before compositionend", () => {
      const order: string[] = []
      field.addEventListener("input", (event) => order.push(`input ${event.inputType} ${event.isComposing}`))
      field.addEventListener("compositionend", () => order.push("compositionend"))
      testRoot.renderer.simulateComposition(id(), [{ key: "a", action: "mark", text: "あ" }])
      order.length = 0
      testRoot.renderer.simulateComposition(id(), [{ key: "Enter", action: "commit", text: "あ" }])
      expect(order).toEqual(["input insertCompositionText true", "compositionend"])
    })

    it("undo and redo fire input, and so do cut and paste", () => {
      const types: unknown[] = []
      field.addEventListener("input", (event) => types.push(event.inputType))
      press("a Meta+z Meta+Shift+z Meta+a Meta+x")
      expect(types).toEqual(["insertText", "historyUndo", "historyRedo", "deleteByCut"])
    })

    it("an edit with nothing to change fires nothing", () => {
      press("Backspace Delete")
      expect(log).toEqual([])
    })
  })
})
