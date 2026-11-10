/** DOM attributes reach the native tree through `setAttribute`, so a selector matcher reads them without JS. */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createSignal } from "solid-js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("attributes on native in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    app.unmount()
  })

  it("sends class, data-* and primitive props, and removes them as they go", () => {
    let box: any
    const [klass, setKlass] = createSignal<string | undefined>("a b")
    const [data, setData] = createSignal<string | number | boolean | undefined>("1")
    const [title, setTitle] = createSignal<string | undefined>("t")
    app.render(() => (
      <div ref={(element: unknown) => (box = element)} class={klass()} data-x={data()} title={title()} />
    ))
    const read = (name: string) => app.renderer.getAttribute(box.nativeId, name)
    expect([read("class"), read("data-x"), read("title")]).toEqual(["a b", "1", "t"])

    app.flushSync(() => {
      setKlass("c")
      setData(2)
      setTitle(undefined)
    })
    expect([read("class"), read("data-x"), read("title")]).toEqual(["c", "2", null])

    app.flushSync(() => setData(true))
    expect(read("data-x")).toBe("")

    app.flushSync(() => {
      setData(false)
      setKlass(undefined)
    })
    expect([read("class"), read("data-x")]).toEqual([null, null])
  })

  it("sends nothing for a handler, a style or an object", () => {
    let box: any
    app.render(() => (
      <div
        ref={(element: unknown) => (box = element)}
        style={{ width: 4 }}
        onClick={() => {}}
        {...({ extra: { a: 1 } } as object)}
      />
    ))
    for (const name of ["style", "onclick", "onClick", "extra"]) {
      expect(app.renderer.getAttribute(box.nativeId, name)).toBeNull()
    }
  })
})
