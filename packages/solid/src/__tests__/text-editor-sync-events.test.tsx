import { clipboard } from "@ghia/native/host"
import { createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

// The tests call the native renderer directly so that no `dispatchNativeEvents` hides a queued event.
describe.skipIf(!hasNativeTestRenderer)("Solid text editor events are delivered synchronously", () => {
  const mount = (log: string[], initial = "") => {
    const app = createTestRoot()
    let field!: any
    app.render(() => {
      const [text, setText] = createSignal(initial)
      return (
        <div style={{ width: 300, height: 100 }}>
          <input
            testId="field"
            ref={field}
            value={text()}
            style={{ width: 200, height: 30 }}
            onKeyDown={(event) => log.push(`keydown ${event.key}`)}
            onKeyUp={(event) => log.push(`keyup ${event.key}`)}
            onCompositionStart={(event) => log.push(`compositionstart ${JSON.stringify(event.data)}`)}
            onCompositionUpdate={(event) => log.push(`compositionupdate ${JSON.stringify(event.data)}`)}
            onCompositionEnd={(event) => log.push(`compositionend ${JSON.stringify(event.data)}`)}
            onInput={(event) => {
              log.push(`input ${event.inputType} ${JSON.stringify(event.value)} ${field.selectionStart}`)
              setText(event.value)
            }}
          />
        </div>
      )
    })
    const native = (app.renderer as any).native
    native.flushIfDirty()
    native.focusElement(app.renderer.findByTestId("field")!.id)
    app.renderer.dispatchNativeEvents()
    return { app, native, field: () => field }
  }

  it("runs keydown, input and keyup in that order before the native call returns", () => {
    const log: string[] = []
    const { native } = mount(log)
    native.simulateKeystrokes("a")
    expect(log).toEqual(["keydown a", 'input insertText "a" 1', "keyup a"])
  })

  it("has run the input handler when the keydown's call returns, before the keyup is sent", () => {
    const log: string[] = []
    const { native } = mount(log)
    native.simulateKeyDown("a")
    expect(log).toEqual(["keydown a", 'input insertText "a" 1'])
    native.simulateKeyUp("a")
    expect(log.at(-1)).toBe("keyup a")
  })

  it("orders a composition's start, update, input and end with each step", () => {
    const log: string[] = []
    const { native } = mount(log)
    native.simulateImeKeyDown("k", "mark", "k")
    expect(log).toEqual([
      "keydown Process",
      'compositionstart ""',
      'compositionupdate "k"',
      'input insertCompositionText "k" 1',
    ])
    native.simulateKeyUp("k")
    log.length = 0
    native.simulateImeKeyDown("Enter", "commit", "か")
    expect(log).toEqual(["keydown Process", 'input insertCompositionText "か" 1', 'compositionend "か"'])
  })

  it("a controlled input keeps the typed text and the caret", () => {
    const log: string[] = []
    const { app, native, field } = mount(log, "ad")
    field().setSelectionRange(1, 1)
    native.simulateKeystrokes("b c")
    app.renderer.dispatchNativeEvents()
    expect(field().value).toBe("abcd")
    expect(field().selectionStart).toBe(3)
  })

  it("delivers paste and cut before the keydown's call returns", async () => {
    const log: string[] = []
    const { native, field } = mount(log, "hello")
    await clipboard.writeText("pasted")
    field().setSelectionRange(5, 5)
    native.simulateKeyDown("Meta+v")
    expect(log).toEqual(["keydown v", 'input insertFromPaste "hellopasted" 11'])
    native.simulateKeyUp("v")
    log.length = 0
    field().setSelectionRange(0, 2)
    native.simulateKeyDown("Meta+x")
    expect(log).toEqual(["keydown x", 'input deleteByCut "llopasted" 0'])
  })
})
