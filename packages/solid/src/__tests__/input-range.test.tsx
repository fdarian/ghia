/** `<input type="range">` in Solid: the value, its sanitization, the keys and the events they fire, controlled values, forms and the slider node. */
// @ts-nocheck

import { createSignal } from "solid-js"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const track = { width: 100, height: 20 }

describe.skipIf(!hasNativeTestRenderer)("Solid input type=range", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  let log: string[]
  let range: any

  beforeEach(() => {
    testRoot = createTestRoot({ width: 400, height: 400 })
    log = []
  })

  const renderer = () => testRoot.renderer
  const press = (keys: string) => renderer().nativeSimulateKeystrokes(renderer().findByTestId("range").id, keys)
  const nodeOf = (authorId: string) =>
    Object.values(renderer().getA11yTree().nodes ?? {})
      .map((node) => node.aria)
      .find((aria) => aria?.author_id === authorId)
  const events = {
    onInput: (event) => log.push(`input:${event.value}`),
    onChange: (event) => log.push(`change:${event.value}`),
  }

  function mount(props = {}) {
    testRoot.render(() => <input id="range" testId="range" type="range" ref={range} style={track} {...props} />)
  }

  it("defaults to the midpoint of 0 to 100, and sanitizes a value to the limits and the step", () => {
    mount()
    expect([range.value, range.valueAsNumber]).toEqual(["50", 50])
    mount({ min: 10, max: 20, step: 4, value: 17 })
    expect(range.value).toBe("18")
    mount({ min: 10, max: 20, step: 4, value: 99 })
    expect(range.value).toBe("18")
  })

  it("a write from code is sanitized and fires nothing, and so do stepUp and stepDown", () => {
    mount({ step: 5, ...events })
    range.value = "23"
    expect(range.value).toBe("25")
    range.valueAsNumber = 500
    expect(range.valueAsNumber).toBe(100)
    range.stepDown(2)
    expect(range.value).toBe("90")
    range.stepUp()
    expect(range.value).toBe("95")
    expect(log).toEqual([])
  })

  it("each key moves the value", () => {
    mount({ min: 0, max: 100, step: 5, defaultValue: 50 })
    range.focus()
    for (const [key, expected] of [
      ["ArrowRight", "55"],
      ["ArrowUp", "60"],
      ["ArrowLeft", "55"],
      ["ArrowDown", "50"],
      ["PageUp", "60"],
      ["PageDown", "50"],
      ["End", "100"],
      ["Home", "0"],
    ]) {
      press(key)
      expect(range.value, key).toBe(expected)
    }
  })

  it("a key fires input and then change, and onChange is the DOM change event", () => {
    mount(events)
    range.focus()
    press("ArrowRight ArrowRight")
    expect(log).toEqual(["input:51", "change:51", "input:52", "change:52"])
  })

  it("a canceled keydown changes nothing and fires nothing, and a stopped value does not move at a limit", () => {
    mount({ ...events, onKeyDown: (event) => event.preventDefault(), defaultValue: 100 })
    range.focus()
    press("ArrowLeft Home")
    expect(range.value).toBe("100")
    mount({ ...events, defaultValue: 100 })
    range.focus()
    press("ArrowRight")
    expect(log).toEqual([])
  })

  it("a controlled value goes back to its prop unless the handler takes the change", () => {
    testRoot.render(() => {
      const [value, setValue] = createSignal(30)
      return (
        <div>
          <input
            testId="range"
            type="range"
            ref={range}
            value={value()}
            style={track}
            onInput={(event) => {
              log.push(`input:${event.value}`)
              if (log.length > 2) setValue(Number(event.value))
            }}
          />
        </div>
      )
    })
    range.focus()
    press("ArrowRight")
    expect(range.value).toBe("30")
    press("ArrowRight")
    expect(range.value).toBe("30")
    press("ArrowRight")
    expect(range.value).toBe("31")
  })

  it("submits name=value", () => {
    const entries: string[][][] = []
    testRoot.render(() => (
      <form ref={(node) => (range = node)} onSubmit={(event) => entries.push(Array.from(event.formData.entries()))}>
        <input testId="range" type="range" name="volume" style={track} />
        <input type="range" name="off" disabled />
      </form>
    ))
    const form = range
    form.requestSubmit()
    expect(entries.pop()).toEqual([["volume", "50"]])
    renderer().focusElement(renderer().findByTestId("range").id)
    press("End")
    form.requestSubmit()
    expect(entries.pop()).toEqual([["volume", "100"]])
  })

  it("is a slider node with its value and limits", () => {
    mount({ min: 10, max: 30, step: 5, value: 20 })
    expect(nodeOf("range")).toEqual(expect.objectContaining({ role: "Slider" }))
    expect(JSON.stringify(nodeOf("range"))).toMatch(/"numeric_value":20/)
  })
})
