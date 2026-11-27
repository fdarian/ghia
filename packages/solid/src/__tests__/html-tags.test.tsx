/// HTML tags are host elements in Solid as in React: `<p>` mounts, lays out with its default margins, and an inline tag
/// runs on in the paragraph of its parent. The Chrome oracle is read by the React suite (`html-tags.test.tsx`).
import fs from "fs"
import { describe, expect, it } from "vitest"
import { document, getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const SQUARE_FONT = fs.readFileSync(new URL("../../../react/src/__tests__/fixtures/gpuix-test-square.ttf", import.meta.url))
/** GpuixTestSquare has no space: the fallback font's is 569/2048 em. */
const SPACE = (569 / 2048) * 20
const PAGE = { position: "absolute", left: 0, top: 0, width: 400, fontFamily: "GpuixTestSquare", fontSize: 20, lineHeight: 1, color: "#000000" } as const

describe.skipIf(!hasNativeTestRenderer)("Solid HTML tags", () => {
  it("mounts a paragraph with its default margins and a heading", () => {
    const app = createTestRoot({ width: 800, height: 600 })
    try {
      app.renderer.registerFont(SQUARE_FONT)
      app.render(() => (
        <div style={PAGE}>
          <h1 testId="h1">AA</h1>
          <p testId="p">AA</p>
        </div>
      ))
      const bounds = (id: string) => app.renderer.getElementBounds(app.renderer.findByTestId(id)!.id)!
      expect(bounds("h1").y).toBeCloseTo(26.8, 0)
      expect(bounds("h1").height).toBe(40)
      expect(bounds("p").y).toBeCloseTo(93.6, 0)
    } finally {
      app.unmount()
    }
  })

  it("runs an inline tag on in the paragraph of its parent", () => {
    const app = createTestRoot({ width: 800, height: 600 })
    try {
      app.renderer.registerFont(SQUARE_FONT)
      app.render(() => (
        <div style={PAGE}>
          <p testId="p">
            AA <strong testId="strong">AA</strong> <a testId="a">AA</a>
          </p>
        </div>
      ))
      const bounds = (id: string) => app.renderer.getElementBounds(app.renderer.findByTestId(id)!.id)!
      expect(bounds("p").height).toBe(20)
      expect(bounds("strong").x).toBeCloseTo(40 + SPACE, 1)
      expect(bounds("a").x).toBeCloseTo(80 + 2 * SPACE, 1)
    } finally {
      app.unmount()
    }
  })
  it("lays out nothing for the elements that hold data or code for the page, and no area is a tab stop", () => {
    const app = createTestRoot({ width: 800, height: 600 })
    const hidden = ["style", "script", "title", "template", "link", "meta", "noscript", "datalist", "noembed", "noframes", "param", "rp", "base", "basefont", "area"]
    try {
      app.renderer.registerFont(SQUARE_FONT)
      app.render(() => (
        <div style={PAGE}>
          <style testId="style">{".never { color: red }"}</style>
          <script testId="script">{"console.log('never')"}</script>
          <title testId="title">Never drawn</title>
          <template testId="template">Never drawn</template>
          <link testId="link" />
          <meta testId="meta" />
          <noscript testId="noscript">Never drawn</noscript>
          <datalist testId="datalist">Never drawn</datalist>
          <noembed testId="noembed">Never drawn</noembed>
          <noframes testId="noframes">Never drawn</noframes>
          <param testId="param" />
          <rp testId="rp">(</rp>
          <base testId="base" />
          <basefont testId="basefont" />
          <area testId="area" href="/map" />
          <a testId="a" href="/page">
            AA
          </a>
          <p testId="p">AA</p>
        </div>
      ))
      const find = (id: string) => app.renderer.findByTestId(id)!.id
      for (const tag of hidden) {
        expect(app.renderer.getElementBounds(find(tag)), tag).toBeFalsy()
        expect(getComputedStyle(document.querySelector(tag)!).display, tag).toBe("none")
      }
      // The text of the hidden elements took no line: the paragraph follows the link line (20) and its own margin (20).
      expect(app.renderer.getElementBounds(find("p"))!.y).toBeCloseTo(20 + 20, 0)
      const focused = () => app.renderer.getElement(app.renderer.getFocusedElementId()!)?.testId ?? null
      app.renderer.simulateKeystrokes("Tab")
      expect(focused()).toBe("a")
      app.renderer.simulateKeystrokes("Tab")
      expect(focused()).toBe("a")
    } finally {
      app.unmount()
    }
  })
})
