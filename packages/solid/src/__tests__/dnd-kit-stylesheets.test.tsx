/**
 * The three sheets @dnd-kit/dom 0.5.3 injects (packages/native/src/css/sheet/fixtures/dnd-kit.css), loaded as `<style>`
 * elements and as constructed sheets in `document.adoptedStyleSheets`, applied to a dragged item, its placeholder and an overlay.
 *
 * `getComputedStyle` answers a fixed set of properties, so `cursor`, `user-select` and `pointer-events` are read from the
 * effective style the test renderer dumps (`getElement().style`), and `top` and `left` from the laid-out box.
 */
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createSignal } from "solid-js"
import { CSSStyleSheet, document, getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const SHEET_TEXTS = readFileSync(new URL("../../../native/src/css/sheet/fixtures/dnd-kit.css", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")

type Loading = "style elements" | "adopted style sheets"

function adoptSheets(): CSSStyleSheet[] {
  return SHEET_TEXTS.map((text) => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(text)
    return sheet
  })
}

describe.skipIf(!hasNativeTestRenderer).each<Loading>(["style elements", "adopted style sheets"])(
  "@dnd-kit/dom sheets as %s",
  (loading) => {
    let app: ReturnType<typeof createTestRoot>

    beforeEach(() => {
      if (loading === "adopted style sheets") document.adoptedStyleSheets = adoptSheets()
      app = createTestRoot()
    })

    afterEach(() => {
      app.unmount()
      document.adoptedStyleSheets = []
    })

    const effective = (element: any) => app.renderer.getElement(element.nativeId)!.style

    function renderScene() {
      const [dragging, setDragging] = createSignal(true)
      const [dropping, setDropping] = createSignal(false)
      const nodes: Record<string, any> = {}
      const ref = (name: string) => (element: unknown) => (nodes[name] = element)
      app.render(() => (
        <div style={{ width: 400, height: 300 }}>
          {loading === "style elements" && SHEET_TEXTS.map((text) => <style>{text}</style>)}
          <div
            ref={ref("item")}
            data-dnd-dragging={dragging() ? "" : undefined}
            data-dnd-dropping={dropping() ? "" : undefined}
            style={{
              position: "absolute",
              top: 1,
              left: 2,
              right: 5,
              bottom: 7,
              "--dnd-top": "30px",
              "--dnd-left": "40px",
              "--dnd-width": "120px",
              "--dnd-height": "60px",
              "--dnd-translate": "10px 20px",
            }}
          >
            <div ref={ref("child")} style={{ width: 10, height: 10 }} />
          </div>
          <div ref={ref("sibling")} style={{ width: 50, height: 20 }} />
          <div ref={ref("placeholder")} data-dnd-placeholder="hidden" style={{ width: 50, height: 20 }} />
          <div ref={ref("overlay")} data-dnd-overlay="" />
          <div ref={ref("draggedOverlay")} data-dnd-overlay="" data-dnd-dragging="" />
          <div ref={ref("scaled")} data-dnd-dragging="" style={{ "--dnd-scale": "1.5", width: 20, height: 20 }} />
        </div>
      ))
      return { nodes, setDragging, setDropping }
    }

    it("pins the dragged item with the variables, drops its inline right and bottom, and translates it", () => {
      const scene = renderScene()
      const item = getComputedStyle(scene.nodes.item)
      expect(item.position).toBe("fixed")
      expect(item.width).toBe("120px")
      expect(item.height).toBe("60px")
      expect(item.maxWidth).toBe("120px")
      expect(item.maxHeight).toBe("60px")
      expect(item.translate).toBe("10px 20px")
      expect(item.transform).toBe("none")
      // top: 30px and left: 40px from the variables, moved by the 10px 20px translate.
      expect(app.renderer.getElementBounds(scene.nodes.item.nativeId)).toMatchObject({ x: 50, y: 50, width: 120, height: 60 })
      expect(effective(scene.nodes.item)).not.toHaveProperty("right")
      expect(effective(scene.nodes.item)).not.toHaveProperty("bottom")
    })

    it("scales the item that has the scale variable in its inline style", () => {
      const scene = renderScene()
      expect(getComputedStyle(scene.nodes.scaled).scale).toBe("1.5")
      expect(getComputedStyle(scene.nodes.item).scale).toBe("none")
    })

    it("takes the translate away while the item is dropping", () => {
      const scene = renderScene()
      app.flushSync(() => scene.setDropping(true))
      expect(getComputedStyle(scene.nodes.item).translate).toBe("none")
      expect(getComputedStyle(scene.nodes.item).position).toBe("fixed")
    })

    it("turns pointer events off on the dragged item and everything in it, and the pointer passes through", () => {
      const scene = renderScene()
      expect(effective(scene.nodes.item).pointerEvents).toBe("none")
      expect(effective(scene.nodes.child).pointerEvents).toBe("none")
      expect(effective(scene.nodes.sibling)).not.toHaveProperty("pointerEvents")
      const hits = app.renderer.getElementsAt(60, 60)
      expect(hits).not.toContain(scene.nodes.item.nativeId)
      expect(hits).not.toContain(scene.nodes.child.nativeId)
    })

    it("sets the grabbing cursor and no text selection on every element", () => {
      const scene = renderScene()
      for (const name of ["item", "child", "sibling", "placeholder", "overlay"]) {
        expect(effective(scene.nodes[name]).cursor).toBe("grabbing")
        expect(effective(scene.nodes[name]).userSelect).toBe("none")
      }
    })

    it("hides the placeholder that is marked hidden and stops its transitions", () => {
      const scene = renderScene()
      expect(getComputedStyle(scene.nodes.placeholder).visibility).toBe("hidden")
      expect(getComputedStyle(scene.nodes.placeholder).transition).toBe("none")
      expect(getComputedStyle(scene.nodes.sibling).visibility).toBe("visible")
    })

    it("hides an overlay that is not being dragged", () => {
      const scene = renderScene()
      expect(getComputedStyle(scene.nodes.overlay).display).toBe("none")
      expect(getComputedStyle(scene.nodes.overlay).visibility).toBe("hidden")
      expect(getComputedStyle(scene.nodes.draggedOverlay).display).toBe("block")
    })

    it("gives the inline styles back when data-dnd-dragging goes", () => {
      const scene = renderScene()
      expect(app.renderer.getElementsAt(60, 60)).not.toContain(scene.nodes.item.nativeId)
      app.flushSync(() => scene.setDragging(false))
      const item = getComputedStyle(scene.nodes.item)
      expect(item.position).toBe("absolute")
      expect(item.translate).toBe("none")
      expect(item.maxWidth).toBe("none")
      expect(effective(scene.nodes.item)).toMatchObject({ top: 1, left: 2, right: 5, bottom: 7 })
      expect(effective(scene.nodes.item)).not.toHaveProperty("pointerEvents")
      expect(effective(scene.nodes.child)).not.toHaveProperty("pointerEvents")
      expect(app.renderer.getElementsAt(60, 60)).toContain(scene.nodes.item.nativeId)
      // the universal rules do not depend on the attribute
      expect(effective(scene.nodes.item).cursor).toBe("grabbing")
    })

    // gap: these declarations of the first sheet have no effect, and the same is true of them as inline styles:
    // - `touch-action: none`: StyleDesc has no touch-action field, so the declaration is dropped when the sheet is parsed.
    // - `will-change: translate`: no field either, and getComputedStyle always answers "auto".
    // - `z-index: calc(infinity)`: z-index is a number and `calc(infinity)` is not parsed, so it is dropped as invalid.
    it("documents the declarations that do not take effect", () => {
      const scene = renderScene()
      const item = getComputedStyle(scene.nodes.item)
      expect(effective(scene.nodes.item)).not.toHaveProperty("touchAction")
      expect(item.willChange).toBe("auto")
      expect(item.zIndex).toBe("auto")
    })
  }
)

describe.skipIf(!hasNativeTestRenderer)("@dnd-kit/dom sheets adopted while the window is open", () => {
  it("apply when document.adoptedStyleSheets gains them and stop when it loses them", () => {
    const app = createTestRoot()
    let item: any
    app.render(() => <div ref={(element: unknown) => (item = element)} data-dnd-dragging="" style={{ position: "absolute", right: 5, bottom: 7 }} />)
    const style = () => app.renderer.getElement(item.nativeId)!.style
    expect(getComputedStyle(item).position).toBe("absolute")
    expect(style()).not.toHaveProperty("cursor")

    app.flushSync(() => {
      document.adoptedStyleSheets.push(...adoptSheets())
    })
    expect(getComputedStyle(item).position).toBe("fixed")
    expect(style().cursor).toBe("grabbing")

    app.flushSync(() => {
      document.adoptedStyleSheets.splice(0, 1)
    })
    expect(getComputedStyle(item).position).toBe("absolute")
    expect(style().cursor).toBe("grabbing")

    app.flushSync(() => {
      document.adoptedStyleSheets = []
    })
    expect(style()).not.toHaveProperty("cursor")
    app.unmount()
  })
})
