/**
 * `<input type="range">`: the value and its sanitization, the keys, the events they fire, the
 * controlled value, form data, stepUp and stepDown, and the slider node, through the elements an
 * app renders.
 */
// @ts-nocheck

import React, { useState } from "react"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const track = { width: 100, height: 20 }

describeNative("input type=range", () => {
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
  const press = (keys: string, testId = "range") => renderer().nativeSimulateKeystrokes(idOf(testId), keys)
  const ariaNodes = () =>
    Object.values(renderer().getA11yTree().nodes ?? {})
      .map((node) => node.aria)
      .filter(Boolean)
  const nodeOf = (authorId: string) => ariaNodes().find((aria) => aria.author_id === authorId)
  const listen = (node: any) => {
    for (const type of ["input", "change"]) node.addEventListener(type, () => log.push(`${type}:${node.value}`))
  }

  function mount(props = {}) {
    testRoot.render(
      <div style={{ width: 400, height: 200 }}>
        <input
          testId="range"
          id="range"
          type="range"
          ref={(node) => {
            if (!node) return
            if (!nodes.range) listen(node)
            nodes.range = node
          }}
          style={track}
          {...props}
        />
      </div>,
    )
    return nodes.range
  }

  describe("the value", () => {
    it("defaults to 0 to 100 by 1 with the midpoint as its value", () => {
      const range = mount()
      expect(range.value).toBe("50")
      expect(range.valueAsNumber).toBe(50)
      expect([range.min, range.max, range.step]).toEqual(["", "", ""])
    })

    it("is clamped to the limits and snapped to the step counted from min", () => {
      const range = mount({ min: 10, max: 20, step: 4, value: 17 })
      expect(range.value).toBe("18")
      testRoot.render(<input testId="range" type="range" ref={ref("range")} min={10} max={20} step={4} value={99} />)
      expect(nodes.range.value).toBe("18")
      testRoot.render(<input testId="range" type="range" ref={ref("range")} min={10} max={20} step={4} value={-5} />)
      expect(nodes.range.value).toBe("10")
    })

    it("sanitizes again when a limit changes, and the midpoint follows the limits", () => {
      testRoot.render(<input testId="range" type="range" ref={ref("range")} defaultValue={90} />)
      expect(nodes.range.value).toBe("90")
      testRoot.render(<input testId="range" type="range" ref={ref("range")} defaultValue={90} max={60} />)
      expect(nodes.range.value).toBe("60")
      testRoot.render(<input testId="range" type="range" ref={ref("range")} min={10} max={20} />)
      expect(nodes.range.value).toBe("15")
    })

    it("snaps a decimal step without float noise, and step any does not snap", () => {
      const range = mount({ min: 0, max: 1, step: 0.1, value: 0.3 })
      expect(range.value).toBe("0.3")
      testRoot.render(<input testId="range" type="range" ref={ref("range")} step="any" value={33.3333} />)
      expect(nodes.range.value).toBe("33.3333")
    })

    it("a value that is not a number is the midpoint", () => {
      const range = mount({ value: "abc" })
      expect(range.value).toBe("50")
    })

    it("a write to value is sanitized, and fires nothing", () => {
      const range = mount({ step: 5 })
      range.value = "23"
      expect(range.value).toBe("25")
      range.value = "500"
      expect(range.value).toBe("100")
      range.valueAsNumber = 7
      expect(range.valueAsNumber).toBe(5)
      range.stepUp()
      range.stepDown(3)
      expect(range.value).toBe("0")
      expect(log).toEqual([])
    })

    it("min, max and step are attributes as text, and an assignment sanitizes the value", () => {
      const range = mount({ min: 0, max: 100, step: 10, value: 50 })
      expect([range.min, range.max, range.step]).toEqual(["0", "100", "10"])
      range.max = 20
      expect(range.max).toBe("20")
      expect(range.value).toBe("20")
    })
  })

  describe("stepUp and stepDown", () => {
    it("move by count steps, clamp, and do not fire events", () => {
      const range = mount({ min: 0, max: 10, step: 2, defaultValue: 4 })
      range.stepUp()
      expect(range.value).toBe("6")
      range.stepUp(2)
      expect(range.value).toBe("10")
      range.stepUp()
      expect(range.value).toBe("10")
      range.stepDown(10)
      expect(range.value).toBe("0")
      expect(log).toEqual([])
    })

    it("throws an InvalidStateError for step any", () => {
      const range = mount({ step: "any" })
      expect(() => range.stepUp()).toThrow(expect.objectContaining({ name: "InvalidStateError" }))
    })
  })

  describe("keys", () => {
    const at = (value: number, extra = {}) => mount({ min: 0, max: 100, step: 5, defaultValue: value, ...extra })

    it("ArrowRight and ArrowUp add a step, ArrowLeft and ArrowDown take one", () => {
      const range = at(50)
      range.focus()
      press("ArrowRight")
      expect(range.value).toBe("55")
      press("ArrowUp")
      expect(range.value).toBe("60")
      press("ArrowLeft")
      expect(range.value).toBe("55")
      press("ArrowDown")
      expect(range.value).toBe("50")
    })

    it("PageUp and PageDown move by a tenth of the range, or one step if that is larger", () => {
      const range = at(50)
      range.focus()
      press("PageUp")
      expect(range.value).toBe("60")
      press("PageDown PageDown")
      expect(range.value).toBe("40")
      testRoot.render(<input testId="range" type="range" ref={ref("range")} min={0} max={10} step={5} defaultValue={0} />)
      nodes.range.focus()
      press("PageUp")
      expect(nodes.range.value).toBe("5")
    })

    it("Home goes to min and End to max", () => {
      const range = at(50)
      range.focus()
      press("End")
      expect(range.value).toBe("100")
      press("Home")
      expect(range.value).toBe("0")
    })

    it("step any moves by a hundredth of the range", () => {
      const range = mount({ min: 0, max: 200, step: "any", defaultValue: 10 })
      range.focus()
      press("ArrowRight")
      expect(range.value).toBe("12")
    })

    it("stops at the limits and fires nothing when the value does not move", () => {
      const range = at(100)
      range.focus()
      press("ArrowRight PageUp End")
      expect(range.value).toBe("100")
      expect(log).toEqual([])
    })

    it("a canceled keydown changes nothing and fires nothing", () => {
      const range = at(50)
      range.focus()
      range.addEventListener("keydown", (event) => event.preventDefault())
      press("ArrowRight Home")
      expect(range.value).toBe("50")
      expect(log).toEqual([])
    })

    it("a keydown handler that does not cancel the key leaves the change to the control", () => {
      const range = at(50, { onKeyDown: () => log.push("keydown") })
      range.focus()
      press("ArrowRight")
      expect(log).toEqual(["keydown", "input:55", "change:55"])
    })

    it("a disabled range is not focused and takes no key", () => {
      const range = at(50, { disabled: true })
      range.focus()
      press("ArrowRight")
      expect(range.value).toBe("50")
    })

    it("a modifier key leaves the arrow alone", () => {
      const range = at(50)
      range.focus()
      press("Meta+ArrowRight")
      expect(range.value).toBe("50")
    })

    it("a key of the range does not scroll the scroller around it", () => {
      testRoot.render(
        <div testId="scroller" style={{ width: 200, height: 50, overflow: "scroll" }}>
          <input testId="range" type="range" ref={ref("range")} style={track} />
          <div style={{ height: 400 }} />
        </div>,
      )
      nodes.range.focus()
      renderer().scrollByKey("down", false)
      expect(renderer().getScrollOffset(idOf("scroller"))).toEqual([0, 0])
    })
  })

  describe("events", () => {
    it("a key fires input and then change, bubbling, with the new value", () => {
      const heard: string[] = []
      testRoot.render(
        <div
          style={{ width: 400, height: 100 }}
          onInput={(event) => heard.push(`ancestor input ${event.target.value}`)}
          onChange={(event) => heard.push(`ancestor change ${event.target.value}`)}
        >
          <input testId="range" type="range" ref={ref("range")} style={track} onInput={(event) => heard.push(`input ${event.value}`)} />
        </div>,
      )
      listen(nodes.range)
      nodes.range.focus()
      press("ArrowRight")
      expect(log).toEqual(["input:51", "change:51"])
      expect(heard).toEqual(["input 51", "ancestor input 51", "ancestor change 51"])
    })

    it("React's onChange is the input event, once per step", () => {
      const values: string[] = []
      mount({ onChange: (event) => values.push(event.value) })
      nodes.range.focus()
      press("ArrowRight ArrowRight PageDown")
      expect(values).toEqual(["51", "52", "42"])
      expect(log.filter((entry) => entry.startsWith("change"))).toEqual(["change:51", "change:52", "change:42"])
    })

    it("onChange reads valueAsNumber from currentTarget, as Base UI does", () => {
      const read: number[] = []
      mount({ onChange: (event) => read.push(event.currentTarget.valueAsNumber) })
      nodes.range.focus()
      press("End")
      expect(read).toEqual([100])
    })
  })

  describe("a controlled value", () => {
    it("goes back to its prop when the handler does not take the change", () => {
      mount({ value: 30, onChange: () => log.push("onChange") })
      nodes.range.focus()
      press("ArrowRight")
      expect(log).toContain("onChange")
      expect(nodes.range.value).toBe("30")
    })

    it("follows the state a handler stores", () => {
      function Controlled() {
        const [value, setValue] = useState(30)
        return <input testId="range" type="range" ref={ref("range")} value={value} style={track} onChange={(event) => setValue(event.currentTarget.valueAsNumber * 2)} />
      }
      testRoot.render(<Controlled />)
      nodes.range.focus()
      press("ArrowRight")
      expect(nodes.range.value).toBe("62")
    })

    it("an uncontrolled range keeps what the user chose", () => {
      mount({ defaultValue: 30 })
      nodes.range.focus()
      press("ArrowRight ArrowRight")
      expect(nodes.range.value).toBe("32")
    })
  })

  describe("forms", () => {
    const submitted = () => {
      const entries: string[][][] = []
      return { entries, onSubmit: (event) => entries.push(Array.from(event.formData.entries())) }
    }

    it("submits name=value, the midpoint by default and the new one after a key, and not a disabled or nameless one", () => {
      const submits = submitted()
      testRoot.render(
        <form ref={ref("form")} onSubmit={submits.onSubmit} style={{ width: 300, height: 100 }}>
          <input testId="range" type="range" name="volume" ref={ref("range")} style={track} />
          <input type="range" name="off" disabled />
          <input type="range" />
        </form>,
      )
      nodes.form.requestSubmit()
      expect(submits.entries.pop()).toEqual([["volume", "50"]])
      nodes.range.focus()
      press("End")
      nodes.form.requestSubmit()
      expect(submits.entries.pop()).toEqual([["volume", "100"]])
    })

    it("does not block implicit submission, so Enter in the one text field submits", () => {
      const submits = submitted()
      testRoot.render(
        <form onSubmit={submits.onSubmit} style={{ width: 300, height: 100 }}>
          <input testId="text" name="t" style={track} />
          <input type="range" name="r" />
        </form>,
      )
      renderer().focusElement(idOf("text"))
      press("x Enter", "text")
      expect(submits.entries.pop()).toEqual([
        ["t", "x"],
        ["r", "50"],
      ])
    })
  })

  describe("focus and accessibility", () => {
    it("is a tab stop that Tab reaches, and not when disabled", () => {
      testRoot.render(
        <div>
          <input testId="range" type="range" ref={ref("range")} style={track} />
          <input testId="off" type="range" disabled style={track} />
        </div>,
      )
      renderer().native.focusNext()
      expect(document.activeElement).toBe(nodes.range)
      renderer().native.focusNext()
      expect(document.activeElement).toBe(nodes.range)
    })

    it("is a slider with its value and limits, which follow a key", () => {
      mount({ min: 10, max: 30, step: 5, defaultValue: 20 })
      expect(nodeOf("range")).toEqual(expect.objectContaining({ role: "Slider" }))
      expect(JSON.stringify(nodeOf("range"))).toMatch(/"numeric_value":20/)
      expect(JSON.stringify(nodeOf("range"))).toMatch(/"min_numeric_value":10/)
      expect(JSON.stringify(nodeOf("range"))).toMatch(/"max_numeric_value":30/)
      nodes.range.focus()
      press("ArrowRight")
      expect(JSON.stringify(nodeOf("range"))).toMatch(/"numeric_value":25/)
    })

    it("an explicit aria-valuenow wins", () => {
      mount({ value: 20, "aria-valuenow": 7 })
      expect(JSON.stringify(nodeOf("range"))).toMatch(/"numeric_value":7/)
    })

    it("has Chrome's default box", () => {
      testRoot.render(<input testId="range" type="range" />)
      const bounds = renderer().getElementBounds(idOf("range"))
      expect([bounds.width, bounds.height]).toEqual([129, 16])
    })
  })

  describe("the type", () => {
    it("a range that becomes a text field is edited as text, and back again", () => {
      mount({ defaultValue: 30 })
      testRoot.render(<input testId="range" type="text" ref={ref("range")} defaultValue="x" />)
      expect(nodes.range.valueAsNumber).toBeNaN()
      testRoot.render(<input testId="range" type="range" ref={ref("range")} defaultValue={30} />)
      expect(nodes.range.value).toBe("30")
    })
  })
})
