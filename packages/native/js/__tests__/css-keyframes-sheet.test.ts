import { afterEach, describe, expect, it } from "vitest"
import { defineKeyframes } from "../keyframes.js"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"

const BOX = 2
const CHILD = 3

describe.skipIf(!hasNativeTestRenderer)("@keyframes and @property in a stylesheet", () => {
  let renderer: TestRenderer

  const computed = (id: number, property: string) => {
    const pairs = renderer.getComputedStyle(id, null)!
    return pairs[pairs.indexOf(property) + 1]
  }

  const frame = (milliseconds: number) => {
    renderer.clockFastForward(milliseconds)
    renderer.drawFrame()
  }

  const setSheet = (css: string) => {
    renderer.applyBatch(encodeWireBatchForTest([["setStyleSheet", 900, css]]))
    renderer.flush()
    renderer.drawFrame()
  }

  const mount = (css: string, boxClass: string, width = 400) => {
    renderer = new TestRenderer({ width, height: 300 })
    renderer.clockPause()
    renderer.applyBatch(
      encodeWireBatchForTest([
        ["createElement", 1, "div"],
        ["setRoot", 1],
        ["createElement", BOX, "div"],
        ["appendChild", 1, BOX],
        ["setAttribute", BOX, "class", boxClass],
        ["setStyleSheet", 900, css],
        ["setAdoptedStyleSheets", [900]],
      ])
    )
    renderer.flush()
    renderer.setInlineDraws(false)
    renderer.drawFrame()
  }

  afterEach(() => renderer?.dispose())

  describe("@keyframes", () => {
    it("plays the animation of a sheet rule from the sheet's keyframes", () => {
      mount(
        `.spin { animation: spin 1s linear infinite } @keyframes spin { to { transform: rotate(360deg) } }`,
        "spin"
      )
      expect(renderer.getAnimations(BOX)).toHaveLength(1)
      frame(0)
      expect(computed(BOX, "transform")).toBe("none")
      frame(250)
      const quarter = computed(BOX, "transform")
      expect(quarter).toMatch(/^matrix\(/)
      const [a, b] = quarter.slice(7, -1).split(",").map(Number)
      expect(a).toBeCloseTo(0, 3)
      expect(b).toBeCloseTo(1, 3)
      frame(250)
      const [halfA] = computed(BOX, "transform").slice(7, -1).split(",").map(Number)
      expect(halfA).toBeCloseTo(-1, 3)
    })

    it("runs the Tailwind v4 spin utility, which names its animation through a variable", () => {
      mount(
        `
        @layer properties {
          @property --tw-rotate-x { syntax: "*"; inherits: false; }
          @property --tw-shadow { syntax: "*"; inherits: false; initial-value: 0 0 #0000; }
        }
        :root { --animate-spin: spin 1s linear infinite; }
        .animate-spin { animation: var(--animate-spin); }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 50% { opacity: 0.5; } }
        `,
        "animate-spin"
      )
      frame(0)
      frame(250)
      expect(computed(BOX, "transform")).toMatch(/^matrix\(/)
      expect(renderer.getAnimations(BOX)).toHaveLength(1)
    })

    it("wins over a definition from script of the same name", () => {
      defineKeyframes("sheet-over-script", { to: { opacity: 0.1 } })
      mount(
        `.a { animation: sheet-over-script 1s linear forwards } @keyframes sheet-over-script { to { opacity: 0.6 } }`,
        "a"
      )
      frame(0)
      frame(1000)
      expect(Number(computed(BOX, "opacity"))).toBeCloseTo(0.6, 3)
    })

    it("leaves a script's definition alone when no sheet defines the name", () => {
      defineKeyframes("script-only", { to: { opacity: 0.1 } })
      mount(`.a { animation: script-only 1s linear forwards }`, "a")
      frame(0)
      frame(1000)
      expect(Number(computed(BOX, "opacity"))).toBeCloseTo(0.1, 3)
    })

    it("switches with an @media query when the window crosses its breakpoint", () => {
      mount(
        `.a { animation: grow 1s linear forwards }
         @keyframes grow { to { opacity: 0.8 } }
         @media (min-width: 600px) { @keyframes grow { to { opacity: 0.2 } } }`,
        "a",
        500
      )
      frame(0)
      frame(1000)
      expect(Number(computed(BOX, "opacity"))).toBeCloseTo(0.8, 3)

      renderer.setWindowSize(700, 300)
      renderer.flush()
      frame(0)
      frame(16)
      expect(Number(computed(BOX, "opacity"))).toBeCloseTo(0.2, 3)

      renderer.setWindowSize(500, 300)
      renderer.flush()
      frame(0)
      frame(16)
      expect(Number(computed(BOX, "opacity"))).toBeCloseTo(0.8, 3)
    })

    it("follows an edit of the sheet that changes the keyframes, and stops when they are removed", () => {
      mount(`.a { animation: edit 1s linear forwards } @keyframes edit { to { opacity: 0.4 } }`, "a")
      frame(0)
      frame(1000)
      expect(Number(computed(BOX, "opacity"))).toBeCloseTo(0.4, 3)

      setSheet(`.a { animation: edit 1s linear forwards } @keyframes edit { to { opacity: 0.7 } }`)
      frame(0)
      frame(16)
      expect(Number(computed(BOX, "opacity"))).toBeCloseTo(0.7, 3)

      setSheet(`.a { animation: edit 1s linear forwards }`)
      frame(0)
      frame(16)
      expect(Number(computed(BOX, "opacity"))).toBe(1)
      expect(renderer.getAnimations(BOX)).toHaveLength(0)
    })

    it("lets an unlayered @keyframes beat a layered one", () => {
      mount(
        `.a { animation: ranked 1s linear forwards }
         @keyframes ranked { to { opacity: 0.3 } }
         @layer later { @keyframes ranked { to { opacity: 0.9 } } }`,
        "a"
      )
      frame(0)
      frame(1000)
      expect(Number(computed(BOX, "opacity"))).toBeCloseTo(0.3, 3)
    })
  })

  describe("@property", () => {
    const tree = (css: string) => {
      mount(css, "c")
      renderer.applyBatch(
        encodeWireBatchForTest([
          ["createElement", CHILD, "div"],
          ["appendChild", BOX, CHILD],
          ["setAttribute", CHILD, "class", "c"],
        ])
      )
      renderer.flush()
      renderer.drawFrame()
    }

    it("gives var() the initial value on an element nothing set the property on", () => {
      tree(`@property --w { syntax: "<length>"; inherits: true; initial-value: 7px } .c { width: var(--w) }`)
      expect(computed(BOX, "width")).toBe("7px")
      expect(computed(BOX, "--w")).toBe("7px")
    })

    it("hands a property that inherits to the elements below", () => {
      tree(`@property --w { syntax: "<length>"; inherits: true; initial-value: 7px } .c { width: var(--w) } .p { --w: 20px }`)
      renderer.applyBatch(encodeWireBatchForTest([["setAttribute", BOX, "class", "c p"]]))
      renderer.flush()
      renderer.drawFrame()
      expect(computed(BOX, "width")).toBe("20px")
      expect(computed(CHILD, "width")).toBe("20px")
    })

    it("does not hand down a property that does not inherit: the element below has the initial value", () => {
      tree(`@property --w { syntax: "<length>"; inherits: false; initial-value: 7px } .c { width: var(--w) } .p { --w: 20px }`)
      renderer.applyBatch(encodeWireBatchForTest([["setAttribute", BOX, "class", "c p"]]))
      renderer.flush()
      renderer.drawFrame()
      expect(computed(BOX, "width")).toBe("20px")
      expect(computed(CHILD, "width")).toBe("7px")
    })

    it("leaves a property that does not inherit and has no initial value empty below", () => {
      tree(`@property --w { syntax: "*"; inherits: false } .c { width: var(--w, 11px) } .p { --w: 20px }`)
      renderer.applyBatch(encodeWireBatchForTest([["setAttribute", BOX, "class", "c p"]]))
      renderer.flush()
      renderer.drawFrame()
      expect(computed(BOX, "width")).toBe("20px")
      expect(computed(CHILD, "width")).toBe("11px")
    })

    it("ignores a rule whose descriptors are not valid", () => {
      tree(`@property --w { syntax: "<length>"; inherits: true } .c { width: var(--w, 9px) }`)
      expect(computed(BOX, "width")).toBe("9px")
    })

    it("takes the registration of a rule under an @media query only while it holds", () => {
      mount(
        `@media (min-width: 600px) { @property --w { syntax: "<length>"; inherits: true; initial-value: 7px } } .c { width: var(--w, 9px) }`,
        "c",
        500
      )
      expect(computed(BOX, "width")).toBe("9px")
      renderer.setWindowSize(700, 300)
      renderer.flush()
      renderer.drawFrame()
      expect(computed(BOX, "width")).toBe("7px")
    })

    it("follows an edit of the sheet", () => {
      mount(`@property --w { syntax: "<length>"; inherits: true; initial-value: 7px } .c { width: var(--w, 9px) }`, "c")
      expect(computed(BOX, "width")).toBe("7px")
      setSheet(`@property --w { syntax: "<length>"; inherits: true; initial-value: 12px } .c { width: var(--w, 9px) }`)
      expect(computed(BOX, "width")).toBe("12px")
      setSheet(`.c { width: var(--w, 9px) }`)
      expect(computed(BOX, "width")).toBe("9px")
    })
  })
})
