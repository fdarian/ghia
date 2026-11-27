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
  renderer.setRetainVerify(true)
  renderer.applyBatch(
    encodeWireBatchForTest([
      ["createElement", 1, "div"],
      ["setRoot", 1],
      ["setStyle", 1, { display: "flex", flexDirection: "column", alignItems: "flex-start", fontSize: 20, color: "rgb(1, 2, 3)" }],
      ["setStyleSheet", 900, sheet],
      ["setAdoptedStyleSheets", [900]],
      ...build,
      // Unchanged while the rest moves, so the frames replay it and the verifier compares the replay.
      ...element(90, 1, "div", "other"),
      ...text(91, 90, "Other"),
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

/** Disposes a renderer once the frames that replayed something were built whole and agreed. */
const done = (renderer: TestRenderer) => {
  expect(renderer.getRetainMismatches()).toEqual([])
  expect(renderer.getRetentionMismatches()).toEqual([])
  renderer.dispose()
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
    done(renderer)
  })

  it("an inline ::after follows the text of its element", () => {
    const renderer = mount(`.a::after { content: " ←" }`, [...element(10, 1, "div", "a"), ...text(11, 10, "Hello")])
    expect(renderer.getPaintedText().some((painted) => painted.includes("Hello ←"))).toBe(true)
    done(renderer)
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
    done(renderer)
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
    done(renderer)
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
    done(renderer)

    const ordered = mount(`${sheet} .row::before { order: 5 }`, build)
    expect(bounds(ordered, 11).x - bounds(ordered, 10).x).toBeCloseTo(0, 0)
    expect(bounds(ordered, 12).x - bounds(ordered, 11).x).toBeCloseTo(40, 0)
    done(ordered)
  })

  it("a state of the element restyles its box: .btn:hover::before", () => {
    const sheet = `.btn::before { content: ""; display: inline-block; width: 10px; height: 10px } .btn:hover::before { width: 50px }`
    const renderer = mount(sheet, [...element(10, 1, "div", "btn"), ...text(11, 10, "Go")])
    const rest = bounds(renderer, 10).width
    renderer.nativeSimulateMouseMove(...centre(renderer, 10))
    expect(bounds(renderer, 10).width).toBeCloseTo(rest + 40, 0)
    renderer.nativeSimulateMouseMove(...OUT)
    expect(bounds(renderer, 10).width).toBeCloseTo(rest, 0)
    expect(renderer.getRetainedCounters().verified, "frames that replayed the unchanged element were compared").toBeGreaterThan(0)
    done(renderer)
  })

  it("a focus variant of the element restyles its box: .btn:focus::before", () => {
    const sheet = `.btn::before { content: ""; display: inline-block; width: 10px; height: 10px } .btn:focus::before { width: 50px }`
    const renderer = mount(sheet, [...element(10, 1, "div", "btn", [["setCustomProp", 10, "tabIndex", 0]]), ...text(11, 10, "Go")])
    const rest = bounds(renderer, 10).width
    renderer.focusElement(10)
    renderer.flush()
    expect(bounds(renderer, 10).width).toBeCloseTo(rest + 40, 0)
    renderer.blurElement(10)
    renderer.flush()
    expect(bounds(renderer, 10).width).toBeCloseTo(rest, 0)
    done(renderer)
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
    done(renderer)
  })

  it("follows the class: a box comes with a rule and goes with it", () => {
    const renderer = mount(`.on::before { content: "→ " }`, [...element(10, 1, "div", "off"), ...text(11, 10, "Hello")])
    const bare = bounds(renderer, 10).width
    apply(renderer, [["setAttribute", 10, "class", "on"]])
    expect(bounds(renderer, 10).width).toBeGreaterThan(bare + 5)
    apply(renderer, [["setAttribute", 10, "class", "off"]])
    expect(bounds(renderer, 10).width).toBeCloseTo(bare, 1)
    done(renderer)
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
    done(renderer)
  })

  it("a box that lies outside its element is where the element is hit", () => {
    const sheet = `.a { position: relative; margin-top: 40px } .a::after { content: ""; position: absolute; bottom: 100%; left: 0; width: 30px; height: 30px }`
    const renderer = mount(sheet, [...element(10, 1, "div", "a"), ...text(11, 10, "Hello")])
    const box = bounds(renderer, 10)
    expect(renderer.getElementsAt(box.x + 10, box.y - 10)).toContain(10)
    expect(renderer.getElementsAt(box.x + 50, box.y - 10)).not.toContain(10)
    done(renderer)
  })

  it("getComputedStyle reads the used size of the box that was drawn", () => {
    const renderer = mount(`.a::before { content: ""; display: block; width: 30px; height: 12px }`, [
      ...element(10, 1, "div", "a"),
      ...text(11, 10, "Hello"),
    ])
    const pairs = renderer.getComputedStyle(10, "before")
    if (!pairs) throw new Error("10 is not in the document")
    const values = new Map<string, string>()
    for (let at = 0; at < pairs.length; at += 2) values.set(pairs[at], pairs[at + 1])
    expect(values.get("width")).toBe("30px")
    expect(values.get("height")).toBe("12px")
    done(renderer)
  })

  it("an element that is destroyed takes its boxes along", () => {
    const renderer = mount(`.a::before { content: "x" }`, [...element(10, 1, "div", "a"), ...text(11, 10, "Hello")])
    // The root, the element and its text, the box and its text, and the element that stays.
    expect(renderer.getRetainedElementCount()).toBe(7)
    apply(renderer, [["destroyElement", 10]])
    expect(renderer.getRetainedElementCount()).toBe(3)
    done(renderer)
  })
  it("a box with overflow: auto scrolls and reports nothing; its element's own scroll reports once, with its own offset", () => {
    const events: { eventType: string; elementId: number; scrollY?: number }[] = []
    const renderer = new TestRenderer({
      width: 400,
      height: 400,
      dispatchEvent: (event: { eventType: string; elementId: number; scrollY?: number }) => events.push(event),
      dispatchSyncEvent: (event: { eventType: string; elementId: number; scrollY?: number }) => {
        events.push(event)
        return { defaultPrevented: false, propagationStopped: false }
      },
    })
    renderer.clockPause()
    renderer.applyBatch(
      encodeWireBatchForTest([
        ["createElement", 1, "div"],
        ["setRoot", 1],
        ["setStyle", 1, { display: "flex", flexDirection: "column", alignItems: "flex-start", fontSize: 14 }],
        [
          "setStyleSheet",
          900,
          `.a { width: 120px; height: 80px; overflow: auto } .a::before { content: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen"; display: block; width: 80px; height: 30px; overflow: auto } .tall { height: 400px }`,
        ],
        ["setAdoptedStyleSheets", [900]],
        ...element(10, 1, "div", "a"),
        ...element(11, 10, "div", "tall"),
        ["setEventListener", 10, "scroll", true],
      ])
    )
    renderer.flush()
    const box = renderer.getElementBounds(10)
    if (!box) throw new Error("10 has no box")
    // On the box: it scrolls, and a listener of its element hears nothing.
    renderer.nativeSimulateScrollWheel(box.x + 10, box.y + 10, 0, 20)
    renderer.flush()
    expect(events.filter((event) => event.eventType === "scroll")).toEqual([])
    // Below the box: the element scrolls, and its event is its own, once.
    renderer.nativeSimulateScrollWheel(box.x + 10, box.y + 60, 0, 20)
    renderer.flush()
    const scrolls = events.filter((event) => event.eventType === "scroll")
    expect(scrolls).toHaveLength(1)
    expect(scrolls[0].elementId).toBe(10)
    expect(scrolls[0].scrollY).toBeLessThan(0)
    expect(-(scrolls[0].scrollY ?? 0)).toBe(renderer.getScrollOffset(10)?.[1])
    renderer.dispose()
  })
  it("keeps the caret of an editing host out of a placeholder box, and does not crash beside it", () => {
    // Tiptap's placeholder: `p.is-empty::before { content: attr(data-placeholder); float: left; height: 0 }`.
    const sheet = `.is-empty::before { content: attr(data-placeholder); float: left; height: 0; pointer-events: none; color: gray } p { margin: 0; height: 24px }`
    const renderer = mount(sheet, [
      ...element(10, 1, "div", "editor", [["setCustomProp", 10, "contentEditable", true], ["setStyle", 10, { width: 300, fontSize: 18 }]]),
      ...element(11, 10, "p", "is-empty", [["setAttribute", 11, "data-placeholder", "Type something"]]),
      ["createElement", 12, "br"],
      ["appendChild", 11, 12],
      ...element(13, 10, "p", "is-empty", [["setAttribute", 13, "data-placeholder", "Before the text"]]),
      ...text(14, 13, "Hello"),
    ])
    renderer.focusElement(10)
    renderer.flush()
    const generated = (id: number) => id >= 2 ** 53
    const box = bounds(renderer, 13)
    let found = 0
    for (const dx of [0, 5, 30, 60, 100, 160, 250]) {
      const point = renderer.caretPositionFromPoint(box.x + dx, box.y + 6)
      if (point) {
        found++
        expect(generated(point.nodeId), `a caret at ${dx} is in a node of the document`).toBe(false)
        expect(generated(point.containerId)).toBe(false)
      }
    }
    expect(found, "the text of the paragraph is hit").toBeGreaterThan(0)
    for (const op of ["lineUp", "lineDown", "lineStart", "lineEnd"]) {
      const moved = renderer.moveCaretVisually(14, 0, op)
      if (moved) expect(generated(moved.nodeId), op).toBe(false)
    }
    const empty = bounds(renderer, 11)
    renderer.nativeSimulateClick(empty.x + 20, empty.y + 6)
    renderer.nativeSimulateClick(box.x + 20, box.y + 6)
    renderer.flush()
    expect(renderer.getPaintedNodeSelection()).toBeDefined()
    done(renderer)
  })
  it("reads the rules of a box that has no content when asked, and makes no box for them", () => {
    // Tailwind's preflight declares no `content`: no element has a box, and the rules are still read.
    const renderer = mount(`*, ::before, ::after { opacity: 0.5 } .a::after { content: "x" }`, [
      ...element(10, 1, "div", "a"),
      ...text(11, 10, "Hello"),
      ...element(12, 1, "div", "b"),
      ...text(13, 12, "Other"),
    ])
    const read = (id: number, pseudo: string) => {
      const pairs = renderer.getComputedStyle(id, pseudo)
      if (!pairs) throw new Error(`${id} is not in the document`)
      const values = new Map<string, string>()
      for (let at = 0; at < pairs.length; at += 2) values.set(pairs[at], pairs[at + 1])
      return values
    }
    expect(read(12, "before").get("opacity")).toBe("0.5")
    expect(read(12, "after").get("opacity")).toBe("0.5")
    expect(read(10, "after").get("opacity")).toBe("0.5")
    expect(read(10, "after").get("content")).toBe('"x"')
    expect(read(10, "before").get("content")).toBe("none")
    // A rematch of an element no content rule reaches makes no box.
    const held = renderer.getRetainedElementCount()
    apply(renderer, [["setAttribute", 12, "class", "b c"]])
    expect(renderer.getRetainedElementCount()).toBe(held)
    done(renderer)
  })
})
