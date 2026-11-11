/** `input` per edit and `change` on commit of an <input> and <textarea>, as on the web. */
import type { HostElement } from "../host.js"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const box = { width: 200, height: 30 }

describe.skipIf(!hasNativeTestRenderer)("Solid input and change events of text controls", () => {
  let app: ReturnType<typeof createTestRoot>
  let log: string[]
  let field!: HostElement
  let other!: HostElement

  beforeEach(() => {
    app = createTestRoot()
    log = []
  })

  const press = (keys: string) => app.renderer.nativeSimulateKeystrokes(app.renderer.findByTestId("field")!.id, keys)

  function mount(tag: "input" | "textarea" = "input") {
    const handlers = {
      testId: "field",
      style: { ...box, height: 60 },
      onInput: (event: { value: string }) => log.push(`onInput ${event.value}`),
      onChange: (event: { value?: string }) => log.push(`onChange ${event.value}`),
      onBlur: () => log.push("blur"),
    }
    app.render(() => (
      <div style={{ width: 400, height: 200 }}>
        {tag === "input" ? <input ref={field} {...handlers} /> : <textarea ref={field} {...handlers} />}
        <input testId="other" ref={other} style={box} />
      </div>
    ))
  }

  it("onInput fires per keystroke and onChange does not", () => {
    mount()
    press("a b")
    expect(log).toEqual(["onInput a", "onInput ab"])
  })

  it("onChange fires on blur after an edit, with the value, before the blur", () => {
    mount()
    field.focus()
    press("a b")
    field.blur()
    expect(log).toEqual(["onInput a", "onInput ab", "onChange ab", "blur"])
  })

  it("a value prop with no handler keeps what the user typed, as on the web", () => {
    app.render(() => <input ref={field} testId="field" value="ab" style={box} />)
    field.focus()
    press("c")
    expect(field.value).toBe("abc")
  })

  it("onChange does not fire on blur without an edit or for a write to value", () => {
    mount()
    field.focus()
    field.blur()
    field.focus()
    field.value = "x"
    field.blur()
    expect(log).toEqual(["blur", "blur"])
  })

  it("onChange fires on Enter in an <input> and a <textarea> takes a newline instead", () => {
    mount()
    field.focus()
    press("a")
    press("Enter")
    expect(log).toEqual(["onInput a", "onChange a"])
    log.length = 0
    mount("textarea")
    field.focus()
    press("a")
    press("Enter")
    expect(log).toEqual(["onInput a", "onInput a\n"])
    expect(field.value).toBe("a\n")
  })

  it("addEventListener hears the same events", () => {
    mount()
    field.addEventListener("input", () => log.push("input"))
    field.addEventListener("change", () => log.push("change"))
    field.focus()
    press("a")
    other.focus()
    expect(log).toEqual(["onInput a", "input", "onChange a", "change", "blur"])
  })

  it("onChange of a checkbox fires after onInput, on the toggle", () => {
    app.render(() => (
      <input
        testId="field"
        ref={field}
        type="checkbox"
        style={{ width: 13, height: 13 }}
        onInput={() => log.push("onInput")}
        onChange={() => log.push("onChange")}
      />
    ))
    field.click()
    expect(log).toEqual(["onInput", "onChange"])
  })
})
