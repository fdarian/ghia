/**
 * Children that change through a spread replace the nodes they inserted before, as in `solid-js/web`, where `<Dynamic>`'s
 * children and `{...props()}` with a `children` key are the same insert.
 */
import { createSignal, For } from "solid-js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { Dynamic } from "../web.js"

describe.skipIf(!hasNativeTestRenderer)("children through a spread in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot({ width: 400, height: 300 })
  })

  afterEach(() => {
    app.unmount()
  })

  const tags = (element: HTMLElement) => [...element.children].map((child) => child.tagName.toLowerCase())

  it("replaces the old children of a Dynamic host element when a conditional switches", () => {
    const [tab, setTab] = createSignal(1)
    let box!: HTMLElement
    app.render(() => (
      <Dynamic component="div" ref={(element: unknown) => (box = element as HTMLElement)}>
        {tab() === 1 ? <ul /> : <article />}
      </Dynamic>
    ))
    expect(tags(box)).toEqual(["ul"])
    app.flushSync(() => setTab(2))
    expect(tags(box)).toEqual(["article"])
    app.flushSync(() => setTab(1))
    expect(tags(box)).toEqual(["ul"])
  })

  it("replaces a For child and a memo child", () => {
    const [mode, setMode] = createSignal<"list" | "detail">("list")
    const [items, setItems] = createSignal(["a", "b"])
    let box!: HTMLElement
    app.render(() => (
      <Dynamic component="div" ref={(element: unknown) => (box = element as HTMLElement)}>
        {mode() === "list" ? <For each={items()}>{(item) => <li>{item}</li>}</For> : <p>detail</p>}
      </Dynamic>
    ))
    expect(tags(box)).toEqual(["li", "li"])
    app.flushSync(() => setItems(["a", "b", "c"]))
    expect(tags(box)).toEqual(["li", "li", "li"])
    app.flushSync(() => setMode("detail"))
    expect(tags(box)).toEqual(["p"])
    app.flushSync(() => setMode("list"))
    expect(tags(box)).toEqual(["li", "li", "li"])
  })

  it("replaces the text a Dynamic element shows", () => {
    const [label, setLabel] = createSignal("one")
    app.render(() => <Dynamic component="span">{label()}</Dynamic>)
    expect(app.renderer.getAllText().join("")).toBe("one")
    app.flushSync(() => setLabel("two"))
    expect(app.renderer.getAllText().join("")).toBe("two")
  })

  it("keeps one set of children when the spread's object is replaced", () => {
    const [step, setStep] = createSignal(0)
    let box!: HTMLElement
    const props = () => (step() === 0 ? { children: <b /> } : { children: <i />, "data-step": "1" })
    app.render(() => <div ref={(element: unknown) => (box = element as HTMLElement)} {...props()} />)
    expect(tags(box)).toEqual(["b"])
    app.flushSync(() => setStep(1))
    expect(tags(box)).toEqual(["i"])
    expect(box.getAttribute("data-step")).toBe("1")
  })
})
