/**
 * The text editor's events (`input`, composition events, the number stepper's `change`) reach JS
 * synchronously, after the edit and in order, in the call that sent the key: not on a later drain.
 * Tests call the native renderer directly so no `dispatchNativeEvents` hides a queued event.
 */
// @ts-nocheck

import React, { useState } from "react"
import { beforeEach, describe, expect, it } from "vitest"
import { clipboard } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("text editor events are delivered synchronously", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  let log: string[]
  let field: any
  let seen: any[]

  const native = () => testRoot.renderer.native
  const id = () => testRoot.renderer.findByTestId("field").id

  const mount = (element: "input" | "textarea", initial = "", props = {}) => {
    log = []
    seen = []
    testRoot = createTestRoot()
    const Tag = element
    function Controlled() {
      const [text, setText] = useState(initial)
      return (
        <div style={{ width: 400, height: 200 }}>
          <Tag
            testId="field"
            ref={(node) => {
              if (node) field = node
            }}
            value={text}
            style={{ width: 300, height: 60 }}
            onKeyDown={(event) => log.push(`keydown ${event.key}`)}
            onKeyUp={(event) => log.push(`keyup ${event.key}`)}
            onCompositionStart={(event) => log.push(`compositionstart ${JSON.stringify(event.data)}`)}
            onCompositionUpdate={(event) => log.push(`compositionupdate ${JSON.stringify(event.data)}`)}
            onCompositionEnd={(event) => log.push(`compositionend ${JSON.stringify(event.data)}`)}
            {...props}
            onChange={(event) => {
              log.push(`input ${event.inputType} ${JSON.stringify(event.value)}`)
              seen.push(event)
              props.onChange?.(event)
              setText(props.transform ? props.transform(event.value) : event.value)
            }}
          />
        </div>
      )
    }
    testRoot.render(<Controlled />)
  }

  const focus = () => {
    native().flushIfDirty()
    native().focusElement(id())
    testRoot.renderer.dispatchNativeEvents()
    log.length = 0
  }

  beforeEach(() => {
    mount("input")
  })

  it("runs keydown, input and keyup in that order before the native call returns", () => {
    focus()
    native().simulateKeystrokes("a")
    expect(log).toEqual(["keydown a", 'input insertText "a"', "keyup a"])
    expect(native().drainEvents().filter((event) => event.eventType === "input")).toEqual([])
  })

  it("has run the input handler when the keydown's call returns, before the keyup is sent", () => {
    focus()
    native().simulateKeyDown("a")
    expect(log).toEqual(["keydown a", 'input insertText "a"'])
    native().simulateKeyUp("a")
    expect(log).toEqual(["keydown a", 'input insertText "a"', "keyup a"])
  })

  it("delivers a run of keys in order, each input before the next keydown", () => {
    focus()
    native().simulateKeystrokes("a b Backspace")
    expect(log).toEqual([
      "keydown a",
      'input insertText "a"',
      "keyup a",
      "keydown b",
      'input insertText "ab"',
      "keyup b",
      "keydown Backspace",
      'input deleteContentBackward "a"',
      "keyup Backspace",
    ])
  })

  it("a keydown that is canceled edits nothing and fires no input", () => {
    mount("input", "", { onKeyDown: (event) => event.preventDefault() })
    focus()
    native().simulateKeystrokes("a")
    expect(log).toEqual(["keyup a"])
    expect(field.value).toBe("")
  })

  describe("composition", () => {
    it("orders start, update, input and end with each step, before the step's keyup", () => {
      focus()
      native().simulateImeKeyDown("k", "mark", "k")
      expect(log).toEqual([
        "keydown Process",
        'compositionstart ""',
        'compositionupdate "k"',
        'input insertCompositionText "k"',
      ])
      native().simulateKeyUp("k")
      log.length = 0
      native().simulateImeKeyDown("a", "mark", "か")
      expect(log).toEqual([
        "keydown Process",
        'compositionupdate "か"',
        'input insertCompositionText "か"',
      ])
      native().simulateKeyUp("a")
      log.length = 0
      native().simulateImeKeyDown("Enter", "commit", "か")
      expect(log).toEqual([
        "keydown Process",
        'input insertCompositionText "か"',
        'compositionend "か"',
      ])
      native().simulateKeyUp("Enter")
      expect(log.at(-1)).toBe("keyup Enter")
      expect(field.value).toBe("か")
    })

    it("cancelling the composition ends it after its input", () => {
      focus()
      native().simulateImeKeyDown("k", "mark", "k")
      native().simulateKeyUp("k")
      log.length = 0
      native().simulateImeKeyDown("Escape", "mark", "")
      expect(log).toEqual([
        "keydown Process",
        'input deleteCompositionText ""',
        'compositionend ""',
      ])
    })

    it("a composition in a controlled input keeps what the input method wrote", () => {
      focus()
      testRoot.renderer.simulateComposition(id(), [
        { key: "k", action: "mark", text: "k" },
        { key: "a", action: "mark", text: "か" },
        { key: "Enter", action: "commit", text: "か" },
      ])
      expect(field.value).toBe("か")
      expect(field.selectionStart).toBe(1)
    })
  })

  describe("a controlled input", () => {
    it("keeps the typed text and the caret when its handler sets the value", () => {
      mount("input", "hello")
      field.setSelectionRange(2, 2)
      focus()
      native().simulateKeystrokes("X Y")
      testRoot.renderer.dispatchNativeEvents()
      expect(field.value).toBe("heXYllo")
      expect([field.selectionStart, field.selectionEnd]).toEqual([4, 4])
    })

    it("keeps the caret in the middle of a run typed in one call", () => {
      mount("input", "ad")
      field.setSelectionRange(1, 1)
      focus()
      native().simulateKeystrokes("b c")
      expect(field.value).toBe("abcd")
      expect(field.selectionStart).toBe(3)
    })

    it("does not revert a value the handler transforms", () => {
      mount("input", "", { transform: (value) => value.toUpperCase() })
      focus()
      native().simulateKeystrokes("a b")
      testRoot.renderer.dispatchNativeEvents()
      expect(field.value).toBe("AB")
      expect(field.selectionStart).toBe(2)
    })

    it("reads the value and the selection inside the input handler", () => {
      const reads = []
      mount("input", "hello", {
        onChange: (event) => {
          reads.push([field.value, field.selectionStart, field.selectionEnd, event.target === field])
          field.setSelectionRange(0, 1)
        },
      })
      field.setSelectionRange(5, 5)
      focus()
      native().simulateKeystrokes("!")
      expect(reads).toEqual([["hello!", 6, 6, true]])
    })
  })

  describe("a textarea", () => {
    beforeEach(() => {
      mount("textarea")
    })

    it("delivers a typed character and a line break in order", () => {
      focus()
      native().simulateKeystrokes("a Enter")
      expect(log).toEqual([
        "keydown a",
        'input insertText "a"',
        "keyup a",
        "keydown Enter",
        'input insertLineBreak "a\\n"',
        "keyup Enter",
      ])
    })

    it("delivers a composition in order", () => {
      focus()
      native().simulateImeKeyDown("k", "mark", "k")
      expect(log).toEqual([
        "keydown Process",
        'compositionstart ""',
        'compositionupdate "k"',
        'input insertCompositionText "k"',
      ])
    })
  })

  describe("paste and cut", () => {
    it("delivers insertFromPaste before the keydown's call returns", async () => {
      mount("input", "hello")
      await clipboard.writeText("pasted")
      field.setSelectionRange(5, 5)
      focus()
      native().simulateKeyDown("Meta+v")
      expect(log).toEqual(["keydown v", 'input insertFromPaste "hellopasted"'])
      expect(seen[0].data).toBe("pasted")
    })

    it("delivers deleteByCut before the keydown's call returns", () => {
      mount("input", "hello")
      field.setSelectionRange(0, 2)
      focus()
      native().simulateKeyDown("Meta+x")
      expect(log).toEqual(["keydown x", 'input deleteByCut "llo"'])
    })
  })

  describe("the number stepper", () => {
    it("delivers input then change in the call of the key", () => {
      mount("input", "1", {
        type: "number",
        onChangeCapture: undefined,
      })
      const changes = []
      field.addEventListener("change", () => changes.push(log.length))
      focus()
      native().simulateKeyDown("ArrowUp")
      expect(log).toEqual(["keydown ArrowUp", 'input  "2"'])
      expect(changes).toHaveLength(1)
    })
  })
})
