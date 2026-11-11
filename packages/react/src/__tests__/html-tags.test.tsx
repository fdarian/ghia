/// HTML tags lay out as Chrome lays them out with its user agent stylesheet: `p` and the headings with their margins,
/// the lists, `blockquote`, `hr`, `pre`, `fieldset`, `button`, a table and the inline tags that run on in the
/// paragraph around them. `fixtures/html-tags-oracle.html` is the page, no margin or padding reset, and
/// `html-tags-oracle.json` the boxes it lays out (`sh fixtures/html-tags-oracle.sh`).

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, it } from "vitest"
import { UniversalStyle } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { expectBoxes, tagsOf } from "./oracle-boxes.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Oracle = Record<string, { html: string; boxes: Record<string, [number, number, number, number]> }>

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const ORACLE: Oracle = JSON.parse(fs.readFileSync(path.join(FIXTURES, "html-tags-oracle.json"), "utf8"))
const SQUARE_FONT = fs.readFileSync(path.join(FIXTURES, "gpuix-test-square.ttf"))
const SPACE = (569 / 2048) * 20
const PAGE = { position: "absolute", left: 0, top: 0, width: 400, fontFamily: "GpuixTestSquare", fontSize: 20, lineHeight: 1, color: "#000000" } as const

/** GpuixTestSquare has no space, so a space is the fallback font's: 5 px wide in Chrome and 5.55 in gpuix. */
const toleranceOf = (html: string) => 0.06 + 0.6 * (html.replace(/<[^>]*>/g, "").match(/ /g)?.length ?? 0)

/** `ul ul { margin-block: 0 }` is a selector on where the list is, which a style per tag cannot say: the nested list says it itself. */
const SPELLED_OUT: Record<string, (html: string) => string> = {
  "nested lists": (html) => html.replace('<ul id="inner">', '<ul id="inner" style="margin-top:0;margin-bottom:0">'),
}

describeNative("HTML tags against Chrome", () => {
  for (const [name, source] of Object.entries(ORACLE)) {
    it(name, () => {
      const { render, renderer, unmount } = createTestRoot({ width: 800, height: 600 })
      try {
        renderer.registerFont(SQUARE_FONT)
        render(<div style={PAGE}>{tagsOf((SPELLED_OUT[name] ?? ((html) => html))(source.html))}</div>)
        expectBoxes(renderer, source.boxes, toleranceOf(source.html))
      } finally {
        unmount()
      }
    })
  }

  it("an own style and a universal style win over the user agent's, and a change redraws", () => {
    const { render, renderer, unmount } = createTestRoot({ width: 800, height: 600 })
    try {
      renderer.registerFont(SQUARE_FONT)
      const bounds = (id: string) => renderer.getElementBounds(renderer.findByTestId(id)!.id)!
      const page = (margin: number | undefined, color: string, universal = false) => (
        <div style={PAGE}>
          {universal && <UniversalStyle style={{ marginTop: 0, marginBottom: 0 }} />}
          <h2 testId="h2" style={{ color, marginTop: margin }}>
            AA
          </h2>
          <p testId="p" style={{ color }}>
            AA
          </p>
        </div>
      )
      render(page(undefined, "#ff0000"))
      expect(bounds("h2").y).toBeCloseTo(0.83 * 30, 1)
      render(page(0, "#00ff00"))
      expect(bounds("h2").y).toBe(0)
      expect(bounds("p").y).toBeCloseTo(30 + 0.83 * 30, 1)
      render(page(undefined, "#0000ff"))
      expect(bounds("h2").y).toBeCloseTo(0.83 * 30, 1)

      render(page(undefined, "#0000ff", true))
      expect(bounds("h2").y).toBe(0)
      expect(bounds("p").y).toBe(30)
    } finally {
      unmount()
    }
  })

  it("an inline tag runs on in the paragraph of its parent", () => {
    const { render, renderer, unmount } = createTestRoot({ width: 800, height: 600 })
    try {
      renderer.registerFont(SQUARE_FONT)
      render(
        <div style={PAGE}>
          <p testId="p">
            AA <strong testId="strong">AA</strong> <em testId="em">AA</em> <a testId="a">AA</a>
          </p>
        </div>
      )
      const bounds = (id: string) => renderer.getElementBounds(renderer.findByTestId(id)!.id)!
      expect(bounds("p").height).toBe(20)
      for (const id of ["strong", "em", "a"]) expect(bounds(id).height, id).toBe(20)
      expect(bounds("strong").x).toBeCloseTo(40 + SPACE, 1)
    } finally {
      unmount()
    }
  })
})
