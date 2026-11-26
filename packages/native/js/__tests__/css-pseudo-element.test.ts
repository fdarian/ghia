/**
 * `::before` and `::after` rules in a stylesheet match the box of the element and cascade to its
 * style, which `getComputedStyle(element, "::before")` reads (nothing is drawn for them yet). The
 * box inherits from its element, `content` reads like Chrome writes it, and everything that
 * matches an element again (a class, an attribute, the pointer, the window) matches its boxes.
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

function mount(sheet: string, build: Op[], width = 400) {
  const renderer = new TestRenderer({
    width,
    height: 400,
    dispatchEvent: () => {},
    dispatchSyncEvent: () => ({ defaultPrevented: false, propagationStopped: false }),
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

type Which = "before" | "after" | null

function read(renderer: TestRenderer, id: number, pseudo: Which) {
  const pairs = renderer.getComputedStyle(id, pseudo)
  if (!pairs) throw new Error(`${id} is not in the document`)
  const values = new Map<string, string>()
  for (let at = 0; at < pairs.length; at += 2) values.set(pairs[at], pairs[at + 1])
  return (name: string) => values.get(name)
}

const content = (renderer: TestRenderer, id: number, pseudo: Which) => read(renderer, id, pseudo)("content")

const centre = (renderer: TestRenderer, id: number): [number, number] => {
  const bounds = renderer.getElementBounds(id)!
  return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
}

const OUT: [number, number] = [395, 395]

describe.skipIf(!hasNativeTestRenderer)("::before and ::after in a stylesheet", () => {
  it("reads the style the rules declare for the box, on what the box inherits from its element", () => {
    const renderer = mount(
      `.a { color: rgb(9, 9, 9) } .a::before { content: "x"; color: red; display: block; opacity: 0.5 } .a::after { content: "y" }`,
      element(10, 1, "div", "a", sized(10, 100, 20))
    )
    const before = read(renderer, 10, "before")
    expect(before("content")).toBe('"x"')
    expect(before("color")).toBe("rgb(255, 0, 0)")
    expect(before("display")).toBe("block")
    expect(before("opacity")).toBe("0.5")
    expect(before("font-size"), "inherited through the element from its parent").toBe("20px")

    const after = read(renderer, 10, "after")
    expect(after("content")).toBe('"y"')
    expect(after("color"), "inherited from the element, not from its parent").toBe("rgb(9, 9, 9)")
    expect(after("display")).toBe("inline")
    expect(after("opacity")).toBe("1")

    const own = read(renderer, 10, null)
    expect(own("content")).toBe("normal")
    expect(own("color")).toBe("rgb(9, 9, 9)")
    expect(own("opacity")).toBe("1")
    renderer.dispose()
  })

  it("reads what Chrome reports for a box no rule matches, and for an element without one", () => {
    const renderer = mount(`.a::before { content: "x" }`, element(10, 1, "div", "a", sized(10, 100, 20)).concat(element(11, 1, "div", "b")))
    expect(content(renderer, 10, "after")).toBe("none")
    expect(read(renderer, 10, "after")("color")).toBe("rgb(1, 2, 3)")
    expect(content(renderer, 11, "before")).toBe("none")
    expect(content(renderer, 11, null)).toBe("normal")
    renderer.dispose()
  })

  it("serializes content as Chrome does", () => {
    const renderer = mount(
      [
        `.a::before { content: "a" "b" }`,
        `.b::before { content: 'q"r\\\\s' }`,
        `.c::before { content: none }`,
        `.d::before { content: normal; color: red }`,
        `.e::before { content: "[" attr(data-x) "]" }`,
        `.f::before { content: "line\\A two" }`,
        `.g::before { content: counter(n) " " open-quote }`,
        `.h::before { content: "x" / "alt" }`,
        `.i::before { content: bogus }`,
        `.j::before { content: "\\201C" }`,
      ].join("\n"),
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].flatMap((name, at) =>
        element(10 + at, 1, "div", name, name === "e" ? [["setAttribute", 10 + at, "data-x", 'he"llo']] : [])
      )
    )
    const of = (at: number) => content(renderer, 10 + at, "before")
    expect(of(0)).toBe('"ab"')
    expect(of(1)).toBe('"q\\"r\\\\s"')
    expect(of(2)).toBe("none")
    expect(of(3)).toBe("none")
    expect(read(renderer, 13, "before")("color"), "the rule matched, though there is no box").toBe("rgb(255, 0, 0)")
    expect(of(4)).toBe('"[he\\"llo]"')
    expect(of(5)).toBe('"line\\a two"')
    expect(of(6)).toBe('counter(n) " " open-quote')
    expect(of(7)).toBe('"x"')
    expect(of(8), "an invalid value is dropped").toBe("none")
    expect(of(9)).toBe('"“"')
    renderer.dispose()
  })

  it("keeps an inline style of the element out of the box, and the box out of the element", () => {
    const renderer = mount(
      `.a::before { content: "x"; background-color: blue }`,
      element(10, 1, "div", "a", [["setStyle", 10, { color: "red", content: '"inline"' }]])
    )
    expect(read(renderer, 10, "before")("background-color")).toBe("rgb(0, 0, 255)")
    expect(read(renderer, 10, "before")("color"), "inherited from the element's own color").toBe("rgb(255, 0, 0)")
    expect(content(renderer, 10, "before")).toBe('"x"')
    expect(read(renderer, 10, null)("background-color")).toBe("rgba(0, 0, 0, 0)")
    renderer.dispose()
  })

  it("follows a class, an id and an attribute, and the attribute content reads", () => {
    const renderer = mount(
      `.on::before { content: "on" } #j::after { content: "id" } .a::after { content: attr(data-x) }`,
      element(10, 1, "div", "a off", [["setAttribute", 10, "data-x", "one"]])
    )
    expect(content(renderer, 10, "before")).toBe("none")
    expect(content(renderer, 10, "after")).toBe('"one"')

    renderer.applyBatch(encodeWireBatchForTest([["setAttribute", 10, "class", "a on"]]))
    renderer.flush()
    expect(content(renderer, 10, "before")).toBe('"on"')

    renderer.applyBatch(encodeWireBatchForTest([["setAttribute", 10, "data-x", "two"]]))
    renderer.flush()
    expect(content(renderer, 10, "after")).toBe('"two"')

    renderer.applyBatch(encodeWireBatchForTest([["setAttribute", 10, "id", "j"]]))
    renderer.flush()
    expect(content(renderer, 10, "after"), "an id beats a class").toBe('"id"')

    renderer.applyBatch(encodeWireBatchForTest([["setAttribute", 10, "class", "off"]]))
    renderer.flush()
    expect(content(renderer, 10, "before")).toBe("none")
    expect(content(renderer, 10, "after")).toBe('"id"')
    renderer.dispose()
  })

  it("applies a state of the element to its box, and a state of another element live", () => {
    const renderer = mount(
      `.btn::before { content: "b"; color: rgb(0, 128, 0) } .btn:hover::before { color: blue } .card:hover .icon::after { content: "!" }`,
      [
        ...element(10, 1, "div", "btn", sized(10, 100, 20)),
        ...element(20, 1, "div", "card", sized(20, 200, 60)),
        ...element(21, 20, "div", "icon", sized(21, 20, 20)),
        ...element(22, 1, "div", "icon", sized(22, 20, 20)),
      ]
    )
    expect(read(renderer, 10, "before")("color")).toBe("rgb(0, 128, 0)")
    expect(content(renderer, 21, "after")).toBe("none")

    renderer.nativeSimulateMouseMove(...centre(renderer, 10))
    expect(read(renderer, 10, "before")("color")).toBe("rgb(0, 0, 255)")

    renderer.nativeSimulateMouseMove(...centre(renderer, 21))
    expect(read(renderer, 10, "before")("color")).toBe("rgb(0, 128, 0)")
    expect(content(renderer, 21, "after")).toBe('"!"')
    expect(content(renderer, 22, "after"), "an icon outside the card").toBe("none")

    renderer.nativeSimulateMouseMove(...OUT)
    expect(content(renderer, 21, "after")).toBe("none")
    renderer.dispose()
  })

  it("follows the window across a media query", () => {
    const renderer = mount(
      `@media (min-width: 600px) { .a::before { content: "wide" } } .a::before { color: red }`,
      element(10, 1, "div", "a", sized(10, 100, 20)),
      500
    )
    expect(content(renderer, 10, "before")).toBe("none")
    renderer.setWindowSize(700, 400)
    renderer.flush()
    expect(content(renderer, 10, "before")).toBe('"wide"')
    renderer.setWindowSize(500, 400)
    renderer.flush()
    expect(content(renderer, 10, "before")).toBe("none")
    renderer.dispose()
  })

  it("follows a change of the sheet", () => {
    const renderer = mount(`.a::before { content: "one" }`, element(10, 1, "div", "a", sized(10, 100, 20)))
    expect(content(renderer, 10, "before")).toBe('"one"')
    renderer.applyBatch(encodeWireBatchForTest([["setStyleSheet", 900, `.a::before { content: "two" } .a::after { content: "after" }`]]))
    renderer.flush()
    expect(content(renderer, 10, "before")).toBe('"two"')
    expect(content(renderer, 10, "after")).toBe('"after"')
    renderer.applyBatch(encodeWireBatchForTest([["setAdoptedStyleSheets", []]]))
    renderer.flush()
    expect(content(renderer, 10, "before")).toBe("none")
    renderer.dispose()
  })

  it("draws nothing for a box yet: the element's own box is what it was", () => {
    const boundsOf = (sheet: string) => {
      const renderer = mount(sheet, element(10, 1, "div", "a", sized(10, 100, 20)))
      const bounds = renderer.getElementBounds(10)
      renderer.dispose()
      return bounds
    }
    const without = boundsOf("")
    expect(without).not.toBeNull()
    expect(boundsOf(`.a::before { content: "xxxxxxxx"; display: block; width: 200px }`)).toEqual(without)
  })
})
