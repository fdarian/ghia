import { describe, expect, it } from "vitest"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"

const SHEET = `
.box { opacity: 0.9 }
@media (min-width: 600px) { .box { opacity: 0.5 } }
@media (min-width: 900px) { .box { opacity: 0.25 } }
@media (prefers-color-scheme: dark) { .box { width: 11px } }
@media (prefers-reduced-motion: reduce) { .box { height: 13px } }
@supports (display: grid) { @media (max-width: 400px) { .box { top: 7px } } }
@supports (bogus-property: 1) { .box { left: 9px } }
`

function mount(width: number) {
  const renderer = new TestRenderer({ width, height: 400 })
  renderer.applyBatch(
    encodeWireBatchForTest([
      ["createElement", 1, "div"],
      ["setRoot", 1],
      ["createElement", 2, "div"],
      ["appendChild", 1, 2],
      ["setAttribute", 2, "class", "box"],
      ["setStyleSheet", 900, SHEET],
      ["setAdoptedStyleSheets", [900]],
    ])
  )
  renderer.flush()
  return renderer
}

const style = (renderer: TestRenderer) => renderer.getElement(2)!.style

describe.skipIf(!hasNativeTestRenderer)("@media and @supports in a stylesheet", () => {
  it("applies a rule while its query matches the window, and follows a resize across a breakpoint", () => {
    const renderer = mount(500)
    expect(style(renderer).opacity).toBe(0.9)

    renderer.setWindowSize(700, 400)
    renderer.flush()
    expect(style(renderer).opacity).toBe(0.5)

    renderer.setWindowSize(1000, 400)
    renderer.flush()
    expect(style(renderer).opacity).toBe(0.25)

    renderer.setWindowSize(300, 400)
    renderer.flush()
    expect(style(renderer).opacity).toBe(0.9)
    expect(style(renderer).top).toBeDefined()
  })

  it("loads the sheets again only when a query flips", () => {
    const renderer = mount(500)
    renderer.resetBuildCounters()
    for (const width of [520, 540, 599, 450, 430]) {
      renderer.setWindowSize(width, 400)
      renderer.flush()
    }
    expect(style(renderer).opacity).toBe(0.9)
    expect(renderer.getBuildCounters().elementsRematched).toBe(0)

    renderer.setWindowSize(620, 400)
    renderer.flush()
    expect(renderer.getBuildCounters().elementsRematched).toBeGreaterThan(0)
    expect(style(renderer).opacity).toBe(0.5)

    renderer.resetBuildCounters()
    renderer.setWindowSize(650, 400)
    renderer.setWindowSize(800, 400)
    renderer.flush()
    expect(renderer.getBuildCounters().elementsRematched).toBe(0)
    expect(style(renderer).opacity).toBe(0.5)
  })

  it("follows the window appearance and the OS preferences", () => {
    const renderer = mount(500)
    renderer.setAppearance("light")
    expect(style(renderer).width).toBeUndefined()
    renderer.setAppearance("dark")
    renderer.flush()
    expect(style(renderer).width).toBeDefined()
    renderer.setAppearance("light")
    renderer.flush()
    expect(style(renderer).width).toBeUndefined()

    expect(style(renderer).height).toBeUndefined()
    renderer.setMediaFeatures({ reducedMotion: true })
    renderer.flush()
    expect(style(renderer).height).toBeDefined()
    renderer.setMediaFeatures({ reducedMotion: false })
    renderer.flush()
    expect(style(renderer).height).toBeUndefined()
  })

  it("decides @supports when the sheet is parsed", () => {
    const renderer = mount(500)
    expect(style(renderer).left).toBeUndefined()
  })
})
