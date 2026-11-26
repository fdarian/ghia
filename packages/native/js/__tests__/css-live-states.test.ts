/**
 * `:hover`, `:active`, `:focus` and `:focus-within` outside the subject of a stylesheet selector
 * (`.card:hover .title`, `.peer:focus ~ .y`, Tailwind's `group-hover:`) are read live: the elements
 * they reach match again as the pointer and the focus move, and a document that has no such selector
 * does nothing for them. Every rule sets `opacity`, which the element's effective style reports.
 */
import { describe, expect, it } from "vitest"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"

type Op = unknown[]

const element = (id: number, parent: number, tag: string, cls: string, extra: Op[] = []): Op[] => [
  ["createElement", id, tag],
  ["appendChild", parent, id],
  ["setAttribute", id, "class", cls],
  ...extra,
]

const sized = (id: number, width: number, height: number): Op[] => [["setStyle", id, { width, height }]]

const focusable = (id: number): Op[] => [["setCustomProp", id, "tabIndex", 0]]

function mount(sheet: string, build: Op[]) {
  const renderer = new TestRenderer({
    width: 400,
    height: 400,
    // No JS root listens: the focus events these tests cause go nowhere.
    dispatchEvent: () => {},
    dispatchSyncEvent: () => ({ defaultPrevented: false, propagationStopped: false }),
  })
  renderer.clockPause()
  renderer.applyBatch(
    encodeWireBatchForTest([
      ["createElement", 1, "div"],
      ["setRoot", 1],
      ["setStyle", 1, { display: "flex", flexDirection: "column", alignItems: "flex-start" }],
      ["setStyleSheet", 900, sheet],
      ["setAdoptedStyleSheets", [900]],
      ...build,
    ])
  )
  renderer.setRetainVerify(true)
  renderer.flush()
  return renderer
}

const opacity = (renderer: TestRenderer, id: number) => renderer.getElement(id)!.style.opacity

const centre = (renderer: TestRenderer, id: number): [number, number] => {
  const bounds = renderer.getElementBounds(id)!
  return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
}

const OUT: [number, number] = [395, 395]

const focus = (renderer: TestRenderer, id: number) => {
  renderer.focusElement(id)
  renderer.flush()
}

const blur = (renderer: TestRenderer, id: number) => {
  renderer.blurElement(id)
  renderer.flush()
}

describe.skipIf(!hasNativeTestRenderer)("pointer and focus states outside the subject in a stylesheet", () => {
  it("styles the descendants of the hovered element, and takes it back when the pointer leaves", () => {
    const renderer = mount(".card:hover .title { opacity: 0.5 }", [
      ...element(10, 1, "div", "card", sized(10, 200, 60)),
      ...element(11, 10, "div", "title", sized(11, 100, 20)),
      ...element(12, 10, "div", "inner", sized(12, 100, 20)),
      ...element(13, 12, "div", "title", sized(13, 50, 10)),
      ...element(20, 1, "div", "card", sized(20, 200, 60)),
      ...element(21, 20, "div", "title", sized(21, 100, 20)),
    ])
    expect([11, 13, 21].map((id) => opacity(renderer, id))).toEqual([undefined, undefined, undefined])

    renderer.nativeSimulateMouseMove(...centre(renderer, 11))
    expect([11, 13, 21].map((id) => opacity(renderer, id))).toEqual([0.5, 0.5, undefined])

    renderer.nativeSimulateMouseMove(...centre(renderer, 21))
    expect([11, 13, 21].map((id) => opacity(renderer, id))).toEqual([undefined, undefined, 0.5])

    renderer.nativeSimulateMouseMove(...OUT)
    expect([11, 13, 21].map((id) => opacity(renderer, id))).toEqual([undefined, undefined, undefined])
    expect(renderer.getRetainMismatches()).toEqual([])
    renderer.dispose()
  })

  it("follows a child, an adjacent sibling and a later sibling combinator", () => {
    const renderer = mount(
      ".group:hover > .x { opacity: 0.5 } li:hover + li { opacity: 0.6 } .peer:hover ~ .y { opacity: 0.7 }",
      [
        ...element(10, 1, "div", "group", sized(10, 200, 40)),
        ...element(11, 10, "div", "x", sized(11, 100, 20)),
        ...element(12, 11, "div", "x", sized(12, 50, 10)),
        ...element(30, 1, "li", "", sized(30, 100, 20)),
        ...element(31, 1, "li", "", sized(31, 100, 20)),
        ...element(32, 1, "li", "", sized(32, 100, 20)),
        ...element(40, 1, "div", "peer", sized(40, 100, 20)),
        ...element(41, 1, "div", "y", sized(41, 100, 20)),
        ...element(42, 1, "div", "y", sized(42, 100, 20)),
      ]
    )
    renderer.nativeSimulateMouseMove(...centre(renderer, 10))
    expect([11, 12].map((id) => opacity(renderer, id))).toEqual([0.5, undefined])
    renderer.nativeSimulateMouseMove(...centre(renderer, 31))
    expect([30, 31, 32].map((id) => opacity(renderer, id))).toEqual([undefined, undefined, 0.6])
    renderer.nativeSimulateMouseMove(...centre(renderer, 40))
    expect([41, 42].map((id) => opacity(renderer, id))).toEqual([0.7, 0.7])
    renderer.nativeSimulateMouseMove(...OUT)
    expect([11, 32, 41, 42].map((id) => opacity(renderer, id))).toEqual([undefined, undefined, undefined, undefined])
    renderer.dispose()
  })

  it("follows :active while the button is down", () => {
    const renderer = mount(".a:active .b { opacity: 0.5 }", [
      ...element(10, 1, "div", "a", sized(10, 200, 40)),
      ...element(11, 10, "div", "b", sized(11, 100, 20)),
    ])
    const [x, y] = centre(renderer, 11)
    renderer.nativeSimulateMouseMove(x, y)
    expect(opacity(renderer, 11)).toBeUndefined()
    renderer.nativeSimulateMouseDown(x, y)
    expect(opacity(renderer, 11)).toBe(0.5)
    renderer.nativeSimulateMouseUp(x, y)
    expect(opacity(renderer, 11)).toBeUndefined()
    renderer.dispose()
  })

  it("follows the focus: a peer's later siblings, and the descendants of a :focus-within ancestor", () => {
    const renderer = mount(".peer:focus ~ .y { opacity: 0.5 } .menu:focus-within .item { opacity: 0.6 } .menu:focus .row { opacity: 0.7 }", [
      ...element(10, 1, "input", "peer", [...sized(10, 100, 20), ...focusable(10)]),
      ...element(11, 1, "div", "y", sized(11, 100, 20)),
      ...element(20, 1, "div", "menu", sized(20, 200, 60)),
      ...element(21, 20, "input", "field", [...sized(21, 100, 20), ...focusable(21)]),
      ...element(22, 20, "div", "item", sized(22, 100, 20)),
      ...element(23, 20, "div", "row", sized(23, 100, 20)),
    ])
    expect(opacity(renderer, 11)).toBeUndefined()
    focus(renderer, 10)
    expect([11, 22].map((id) => opacity(renderer, id))).toEqual([0.5, undefined])
    focus(renderer, 21)
    expect([11, 22, 23].map((id) => opacity(renderer, id))).toEqual([undefined, 0.6, undefined])
    blur(renderer, 21)
    expect([11, 22].map((id) => opacity(renderer, id))).toEqual([undefined, undefined])
    expect(renderer.getRetainMismatches()).toEqual([])
    renderer.dispose()
  })

  it("reads Tailwind v4's group-hover and peer-focus output", () => {
    const renderer = mount(
      String.raw`@layer utilities {
        .group-hover\:opacity-50 {
          &:is(:where(.group):hover *) {
            @media (hover: hover) { opacity: 0.5 }
          }
        }
        .peer-focus\:opacity-70 { &:is(:where(.peer):focus ~ *) { opacity: 0.7 } }
      }`,
      [
        ...element(10, 1, "div", "group", sized(10, 200, 60)),
        ...element(11, 10, "div", "wrap", sized(11, 150, 40)),
        ...element(12, 11, "div", "group-hover:opacity-50", sized(12, 100, 20)),
        ...element(13, 1, "div", "group-hover:opacity-50", sized(13, 100, 20)),
        ...element(20, 1, "input", "peer", [...sized(20, 100, 20), ...focusable(20)]),
        ...element(21, 1, "div", "peer-focus:opacity-70", sized(21, 100, 20)),
      ]
    )
    renderer.nativeSimulateMouseMove(...centre(renderer, 12))
    expect([12, 13].map((id) => opacity(renderer, id))).toEqual([0.5, undefined])
    renderer.nativeSimulateMouseMove(...OUT)
    expect(opacity(renderer, 12)).toBeUndefined()
    focus(renderer, 20)
    expect(opacity(renderer, 21)).toBe(0.7)
    renderer.dispose()
  })

  it("matches nothing for the pointer and the focus when no selector reads a state outside its subject", () => {
    const renderer = mount(".a:hover { opacity: 0.5 } .a:focus-within { opacity: 0.6 } .card .title { opacity: 0.8 }", [
      ...element(10, 1, "div", "a", [...sized(10, 200, 60), ...focusable(10)]),
      ...element(11, 10, "div", "b", sized(11, 100, 20)),
    ])
    renderer.resetBuildCounters()
    renderer.nativeSimulateMouseMove(...centre(renderer, 11))
    renderer.nativeSimulateMouseDown(...centre(renderer, 11))
    renderer.nativeSimulateMouseUp(...centre(renderer, 11))
    focus(renderer, 10)
    renderer.nativeSimulateMouseMove(...OUT)
    blur(renderer, 10)
    expect(renderer.getBuildCounters().elementsRematched).toBe(0)
    renderer.dispose()
  })

  it("matches only what the state reaches when a rule reads one", () => {
    const renderer = mount(".card:hover .title { opacity: 0.5 }", [
      ...element(10, 1, "div", "card", sized(10, 200, 60)),
      ...element(11, 10, "div", "title", sized(11, 100, 20)),
      ...element(20, 1, "div", "card", sized(20, 200, 60)),
      ...element(21, 20, "div", "title", sized(21, 100, 20)),
      ...element(22, 20, "div", "title", sized(22, 100, 20)),
    ])
    renderer.nativeSimulateMouseMove(...centre(renderer, 11))
    renderer.resetBuildCounters()
    renderer.nativeSimulateMouseMove(...centre(renderer, 21))
    expect(opacity(renderer, 21)).toBe(0.5)
    expect(renderer.getBuildCounters().elementsRematched).toBeLessThanOrEqual(4)
    renderer.resetBuildCounters()
    focus(renderer, 10)
    expect(renderer.getBuildCounters().elementsRematched).toBe(0)
    renderer.dispose()
  })
  it("matches only the subtree of an element that can hold the compound, however deep the hover chain", () => {
    // A spine of twelve plain divs with ten rows each, and a `.group` at the bottom with three `.x`.
    const build: Op[] = []
    let parent = 1
    let next = 100
    for (let level = 0; level < 12; level++) {
      const id = next++
      build.push(...element(id, parent, "div", "level"))
      for (let row = 0; row < 10; row++) build.push(...element(next++, id, "div", "row", sized(next - 1, 5, 1)))
      parent = id
    }
    build.push(...element(10, parent, "div", "group", sized(10, 60, 30)))
    for (const x of [11, 12, 13]) build.push(...element(x, 10, "div", "x", sized(x, 20, 5)))
    const renderer = mount(".group:hover .x { opacity: 0.5 }", build)
    renderer.nativeSimulateMouseMove(...centre(renderer, 11))
    expect([11, 12, 13].map((id) => opacity(renderer, id))).toEqual([0.5, 0.5, 0.5])
    renderer.nativeSimulateMouseMove(...OUT)
    renderer.resetBuildCounters()
    renderer.nativeSimulateMouseMove(...centre(renderer, 12))
    expect(renderer.getBuildCounters().elementsRematched, "the chain is 15 deep, and only the `.group` reaches its three").toBe(3)
    renderer.resetBuildCounters()
    renderer.nativeSimulateMouseMove(...centre(renderer, 13))
    expect(renderer.getBuildCounters().elementsRematched).toBe(0)
    renderer.dispose()
  })
})
