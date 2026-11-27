/**
 * The boxes of `::before` and `::after` are drawn: they are laid out as children of their element
 * (`::before` first, `::after` last), take part in its paragraph or its flex row, are painted, and
 * a pointer on one is a pointer on the element, as in the DOM. Their text is no node of the
 * document, so a selection leaves it out.
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

const text = (id: number, parent: number, value: string): Op[] => [
  ["createElement", id, "#text"],
  ["setText", id, value],
  ["appendChild", parent, id],
]

type Delivered = { eventType: string; elementId: number; target: number; offsetX: number; offsetY: number }

/** The pointer events the pointer simulation delivered, which native sends to JS in the middle of the input. */
function mount(sheet: string, build: Op[], delivered: Delivered[] = [], width = 400) {
  const renderer = new TestRenderer({
    width,
    height: 400,
    dispatchEvent: () => {},
    dispatchSyncEvent: (event: Delivered) => {
      delivered.push(event)
      return { defaultPrevented: false, propagationStopped: false }
    },
  })
  renderer.clockPause()
  renderer.applyBatch(
    encodeWireBatchForTest([
      ["createElement", 1, "div"],
      ["setRoot", 1],
      ["setStyle", 1, { display: "flex", flexDirection: "column", alignItems: "flex-start", fontSize: 20, color: "rgb(1, 2, 3)" }],
      ["setStyleSheet", 900, sheet],
      ["setAdoptedStyleSheets", [900]],
      ...build,
    ])
  )
  renderer.flush()
  return renderer
}

const bounds = (renderer: TestRenderer, id: number) => {
  const box = renderer.getElementBounds(id)
  if (!box) throw new Error(`${id} has no box`)
  return box
}

const centre = (renderer: TestRenderer, id: number): [number, number] => {
  const box = bounds(renderer, id)
  return [box.x + box.width / 2, box.y + box.height / 2]
}

const apply = (renderer: TestRenderer, ops: Op[]) => {
  renderer.applyBatch(encodeWireBatchForTest(ops))
  renderer.flush()
}

const OUT: [number, number] = [395, 395]

describe.skipIf(!hasNativeTestRenderer)("the boxes of ::before and ::after", () => {
  it("an inline ::before is part of the paragraph of its element: it widens the text and is painted with it", () => {
    const build = [...element(10, 1, "div", "a"), ...text(11, 10, "Hello")]
    const plain = mount("", build)
    const bare = bounds(plain, 10)
    plain.dispose()

    const renderer = mount(`.a::before { content: "→ " }`, build)
    const widened = bounds(renderer, 10)
    expect(widened.width).toBeGreaterThan(bare.width + 5)
    expect(widened.height).toBeCloseTo(bare.height, 1)
    expect(renderer.getPaintedText().some((painted) => painted.includes("→ Hello"))).toBe(true)
    renderer.dispose()
  })

  it("an inline ::after follows the text of its element", () => {
    const renderer = mount(`.a::after { content: " ←" }`, [...element(10, 1, "div", "a"), ...text(11, 10, "Hello")])
    expect(renderer.getPaintedText().some((painted) => painted.includes("Hello ←"))).toBe(true)
    renderer.dispose()
  })

  it("a block ::after adds a line below the text", () => {
    const build = [...element(10, 1, "div", "a"), ...text(11, 10, "Hello")]
    const plain = mount("", build)
    const bare = bounds(plain, 10)
    plain.dispose()

    const renderer = mount(`.a::after { content: "more"; display: block }`, build)
    const grown = bounds(renderer, 10)
    expect(grown.height).toBeGreaterThan(bare.height * 1.8)
    expect(renderer.getPaintedText()).toEqual(expect.arrayContaining(["Hello", "more"]))
    renderer.dispose()
  })

  it("an absolute overlay with no text takes no room, and a pointer on it is a pointer on the element", () => {
    const build = [
      ...element(10, 1, "div", "a", [["setEventListener", 10, "click", true]]),
      ...text(11, 10, "Hello"),
    ]
    const sheet = `.a { position: relative } .a::after { content: ""; position: absolute; inset: 0; background-color: red }`
    const plain = mount("", build)
    const bare = bounds(plain, 10)
    plain.dispose()
    const delivered: Delivered[] = []
    const renderer = mount(sheet, build, delivered)
    expect(bounds(renderer, 10)).toEqual(bare)

    const [x, y] = centre(renderer, 10)
    expect(renderer.getElementsAt(x, y)[0]).toBe(10)
    renderer.nativeSimulateMouseDown(x, y)
    renderer.nativeSimulateMouseUp(x, y)
    const clicks = delivered.filter((event) => event.eventType === "click")
    expect(clicks.length).toBe(1)
    expect(clicks[0].target).toBe(10)
    expect(clicks[0].offsetX).toBeCloseTo(x - bounds(renderer, 10).x, 0)
    renderer.dispose()
  })

  it("a ::before of a flex container is its first item and a ::after its last, and order applies to them", () => {
    const build = [
      ...element(10, 1, "div", "row", [["setStyle", 10, { display: "flex", flexDirection: "row", width: 300 }]]),
      ...element(11, 10, "div", "one", [["setStyle", 11, { width: 40, height: 20 }]]),
      ...element(12, 10, "div", "two", [["setStyle", 12, { width: 40, height: 20 }]]),
    ]
    const sheet = `.row::before { content: ""; width: 10px; height: 20px } .row::after { content: ""; width: 30px; height: 20px }`
    const renderer = mount(sheet, build)
    expect(bounds(renderer, 11).x - bounds(renderer, 10).x).toBeCloseTo(10, 0)
    expect(bounds(renderer, 12).x - bounds(renderer, 11).x).toBeCloseTo(40, 0)
    renderer.dispose()

    const ordered = mount(`${sheet} .row::before { order: 5 }`, build)
    expect(bounds(ordered, 11).x - bounds(ordered, 10).x).toBeCloseTo(0, 0)
    expect(bounds(ordered, 12).x - bounds(ordered, 11).x).toBeCloseTo(40, 0)
    ordered.dispose()
  })

  it("a state of the element restyles its box: .btn:hover::before", () => {
    const sheet = `.btn::before { content: ""; display: inline-block; width: 10px; height: 10px } .btn:hover::before { width: 50px }`
    const renderer = mount(sheet, [...element(10, 1, "div", "btn"), ...text(11, 10, "Go")])
    const rest = bounds(renderer, 10).width
    renderer.nativeSimulateMouseMove(...centre(renderer, 10))
    expect(bounds(renderer, 10).width).toBeCloseTo(rest + 40, 0)
    renderer.nativeSimulateMouseMove(...OUT)
    expect(bounds(renderer, 10).width).toBeCloseTo(rest, 0)
    renderer.dispose()
  })

  it("content: attr() follows the attribute", () => {
    const renderer = mount(`.a::before { content: attr(data-label) " " }`, [
      ...element(10, 1, "div", "a", [["setAttribute", 10, "data-label", "One"]]),
      ...text(11, 10, "x"),
    ])
    expect(renderer.getPaintedText().some((painted) => painted.includes("One x"))).toBe(true)
    apply(renderer, [["setAttribute", 10, "data-label", "Second"]])
    expect(renderer.getPaintedText().some((painted) => painted.includes("Second x"))).toBe(true)
    expect(renderer.getPaintedText().some((painted) => painted.includes("One"))).toBe(false)
    renderer.dispose()
  })

  it("follows the class: a box comes with a rule and goes with it", () => {
    const renderer = mount(`.on::before { content: "→ " }`, [...element(10, 1, "div", "off"), ...text(11, 10, "Hello")])
    const bare = bounds(renderer, 10).width
    apply(renderer, [["setAttribute", 10, "class", "on"]])
    expect(bounds(renderer, 10).width).toBeGreaterThan(bare + 5)
    apply(renderer, [["setAttribute", 10, "class", "off"]])
    expect(bounds(renderer, 10).width).toBeCloseTo(bare, 1)
    renderer.dispose()
  })

  it("the text of a box is not selected or copied", () => {
    const renderer = mount(`.a::before { content: "BEFORE " } .a::after { content: " AFTER"; display: block }`, [
      ...element(10, 1, "div", "a"),
      ...text(11, 10, "Hello"),
    ])
    const box = bounds(renderer, 10)
    renderer.dragSelect(box.x - 2, box.y + 2, box.x + box.width + 40, box.y + box.height - 2)
    const selected = renderer.getSelectedText() ?? ""
    expect(selected).toContain("Hello")
    expect(selected).not.toContain("BEFORE")
    expect(selected).not.toContain("AFTER")
    renderer.dispose()
  })

  it("an element that is destroyed takes its boxes along", () => {
    const renderer = mount(`.a::before { content: "x" }`, [...element(10, 1, "div", "a"), ...text(11, 10, "Hello")])
    // The root, the element and its text, the box and its text.
    expect(renderer.getRetainedElementCount()).toBe(5)
    apply(renderer, [["destroyElement", 10]])
    expect(renderer.getRetainedElementCount()).toBe(1)
    renderer.dispose()
  })
})
