/** `@solidjs/meta` publishes its JSX source under the `solid` condition and imports `escape`, `ssr` and `useAssets` from solid-js/web. */
import { MetaProvider, Title } from "@solidjs/meta"
import { afterEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("@solidjs/meta from source on Ghia", () => {
  let app: ReturnType<typeof createTestRoot> | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
  })

  it("loads and renders what is under its provider", () => {
    app = createTestRoot({ width: 400, height: 300 })
    app.render(() => (
      <MetaProvider>
        <p>body</p>
      </MetaProvider>
    ))
    expect(app.renderer.getAllText().join("")).toBe("body")
  })

  // A Ghia gap, pinned: Title writes `document.createElement("title")`, and a document that draws no `<title>` refuses it.
  it.fails("renders a Title", () => {
    app = createTestRoot({ width: 400, height: 300 })
    app.render(() => (
      <MetaProvider>
        <Title>page</Title>
        <p>body</p>
      </MetaProvider>
    ))
    expect(app.renderer.getAllText().join("")).toBe("body")
  })
})
