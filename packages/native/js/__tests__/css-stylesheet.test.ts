import { afterEach, describe, expect, it, vi } from "vitest"
import { createMutationQueue, type MutationHost } from "../host.js"
import { document } from "../events/window-target.js"
import { CSSRule, CSSRuleList, CSSStyleRule, CSSStyleSheet } from "../css/index.js"
import { splitRules } from "../css/rules.js"
import { registerSheetSink, type SheetSink } from "../css/sheet-sync.js"
import { decodeWireBatchForTest } from "../wire-testing.js"
import "../dom-globals.js"

function recordingRenderer() {
  const batches: unknown[][][] = []
  const renderer: MutationHost = {
    applyBatch(bytes) {
      batches.push(decodeWireBatchForTest(bytes) as unknown[][])
      return []
    },
  }
  const queue = createMutationQueue(renderer)
  return {
    queue,
    /** The sheet ops sent since the last call, in order. */
    sent() {
      queue.flushMutations()
      return batches.splice(0).flat()
    },
  }
}

function errorName(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof DOMException) return error.name
    throw error
  }
  throw new Error("did not throw")
}

afterEach(() => {
  document.adoptedStyleSheets = []
})

describe("splitRules", () => {
  it("finds style rules, at-rules with blocks and statement at-rules", () => {
    const rules = splitRules("@layer a, b; .x { color: red } @media (min-width: 1px) { .y { top: 0 } } @layer a { .z { left: 1px } }")
    expect(rules.map((rule) => rule.text)).toEqual([
      "@layer a, b;",
      ".x { color: red }",
      "@media (min-width: 1px) { .y { top: 0 } }",
      "@layer a { .z { left: 1px } }",
    ])
    expect(rules.map((rule) => rule.atRule)).toEqual([true, false, true, true])
  })

  it("is not fooled by braces and semicolons in strings, comments, escapes and parentheses", () => {
    const rules = splitRules(
      `.a[data-x="}{;"] { content: '}'; background: url(a;b) } /* } */ .b::after { content: "\\"}" } .c\\{ { top: 0 }`
    )
    expect(rules.map((rule) => rule.prelude)).toEqual([`.a[data-x="}{;"]`, ".b::after", ".c\\{"])
    expect(rules).toHaveLength(3)
  })

  it("keeps nested rules inside their parent", () => {
    const rules = splitRules(".a { color: red; &:is(input, button) { border: 0 } .b { top: 0 } } .c { left: 0 }")
    expect(rules).toHaveLength(2)
    expect(rules[0]!.text).toBe(".a { color: red; &:is(input, button) { border: 0 } .b { top: 0 } }")
  })

  it("takes the selector list as the prelude, without comments", () => {
    expect(splitRules(".a /* x */, .b > c { top: 0 }")[0]!.prelude).toBe(".a , .b > c")
  })

  it("closes an unterminated block at the end of the text", () => {
    expect(splitRules(".a { top: 0 ;; .b { left: 0 }").map((rule) => rule.text)).toEqual([".a { top: 0 ;; .b { left: 0 } }"])
  })

  it("closes whatever is open at the end of the text, the way a browser serializes it", () => {
    const texts = (css: string) => splitRules(css).map((rule) => rule.text)
    expect(texts(".a { color: red")).toEqual([".a { color: red }"])
    expect(texts('.a { content: "x')).toEqual(['.a { content: "x" }'])
    expect(texts(".a { top: 0 /* x")).toEqual([".a { top: 0 /* x */ }"])
    expect(texts(".a { background: url(x")).toEqual([".a { background: url(x) }"])
    expect(texts("@media print { .a { top: 0 }")).toEqual(["@media print { .a { top: 0 } }"])
    expect(texts("@layer a, b")).toEqual(["@layer a, b;"])
  })

  it("drops a style rule that has no block", () => {
    expect(splitRules(".a")).toEqual([])
    expect(splitRules(".a { top: 0 } .b").map((rule) => rule.text)).toEqual([".a { top: 0 }"])
  })

  it("takes a stray top-level } into the next rule's prelude, which drops that rule and keeps the ones after it", () => {
    expect(splitRules("} .a{} .b{}").map((rule) => rule.text)).toEqual([".b{}"])
    expect(splitRules(".a{} }} @media print { .b{} } .c{} } .d{} .e{}").map((rule) => rule.prelude)).toEqual([".a", ".c", ".e"])
    expect(splitRules(".a{} .b } .c{} .d{}").map((rule) => rule.prelude)).toEqual([".a", ".b } .c", ".d"])
  })

  it("does not end a style rule at a semicolon outside its block, so a stray one belongs to the next prelude", () => {
    expect(splitRules("a; .b { top: 0 }").map((rule) => rule.prelude)).toEqual(["a; .b"])
    expect(splitRules("@layer a;; .b { top: 0 }").map((rule) => rule.prelude)).toEqual(["@layer a", "; .b"])
  })

  it("is empty for blank text and comments", () => {
    expect(splitRules("  /* nothing */\n")).toEqual([])
  })
})

describe("CSSStyleSheet", () => {
  it("lists its rules as an array-like, iterable list that stays the same object", () => {
    const sheet = new CSSStyleSheet()
    const list = sheet.cssRules
    sheet.replaceSync(".a { top: 0 } @layer x { .b { left: 0 } } @media print { .c { top: 1px } } @layer y, z;")
    expect(list).toBe(sheet.cssRules)
    expect(list).toBeInstanceOf(CSSRuleList)
    expect(list.length).toBe(4)
    expect(list[0]).toBeInstanceOf(CSSStyleRule)
    expect((list[0] as CSSStyleRule).selectorText).toBe(".a")
    expect(list[0]!.type).toBe(CSSRule.STYLE_RULE)
    expect(list[1]).not.toBeInstanceOf(CSSStyleRule)
    expect(list[1]!.type).toBe(0)
    expect(list[2]!.type).toBe(CSSRule.MEDIA_RULE)
    expect(list[3]!.cssText).toBe("@layer y, z;")
    expect(list.item(0)).toBe(list[0])
    expect(list.item(9)).toBeNull()
    expect(list[0]!.parentStyleSheet).toBe(sheet)
    expect([...list].map((rule) => rule.cssText)).toEqual([
      ".a { top: 0 }",
      "@layer x { .b { left: 0 } }",
      "@media print { .c { top: 1px } }",
      "@layer y, z;",
    ])
    sheet.replaceSync(".only { top: 0 }")
    expect(list.length).toBe(1)
    expect(list[1]).toBeUndefined()
  })

  it("replaceSync leaves out @import rules", () => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync('@import url("x.css"); .a { top: 0 }')
    expect(sheet.cssRules.length).toBe(1)
  })

  it("an unterminated rule does not swallow the rules around it", () => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".b { color: blue }")
    expect(sheet.insertRule(".a { color: red", 0)).toBe(0)
    expect(sheet.insertRule("@layer q", 2)).toBe(2)
    expect([...sheet.cssRules].map((rule) => rule.cssText)).toEqual([".a { color: red }", ".b { color: blue }", "@layer q;"])
    expect(sheet.sheetText()).toBe(".a { color: red }\n.b { color: blue }\n@layer q;")
    sheet.replaceSync(".a { color: red\n.c { top: 0 }")
    expect([...sheet.cssRules].map((rule) => rule.cssText)).toEqual([".a { color: red\n.c { top: 0 } }"])
    sheet.replaceSync('.x { content: "a')
    sheet.insertRule(".y { top: 0 }", 1)
    expect(sheet.cssRules.length).toBe(2)
    expect(errorName(() => sheet.insertRule(".z"))).toBe("SyntaxError")
  })

  it("replace answers with the sheet and takes effect after a microtask", async () => {
    const sheet = new CSSStyleSheet()
    const promise = sheet.replace(".a { top: 0 }")
    expect(sheet.cssRules.length).toBe(0)
    expect(await promise).toBe(sheet)
    expect(sheet.cssRules.length).toBe(1)
  })

  it("insertRule puts the rule at the index and answers it, 0 by default", () => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".a { top: 0 } .c { top: 2px }")
    expect(sheet.insertRule(".b { top: 1px }", 1)).toBe(1)
    expect(sheet.insertRule(".z { top: 9px }")).toBe(0)
    expect(sheet.insertRule("@layer q;", sheet.cssRules.length)).toBe(4)
    expect([...sheet.cssRules].map((rule) => rule.cssText)).toEqual([
      ".z { top: 9px }",
      ".a { top: 0 }",
      ".b { top: 1px }",
      ".c { top: 2px }",
      "@layer q;",
    ])
  })

  it("insertRule throws SyntaxError unless the text is exactly one rule, and IndexSizeError for a bad index", () => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".a { top: 0 }")
    expect(errorName(() => sheet.insertRule(".b { top: 0 } .c { top: 0 }"))).toBe("SyntaxError")
    expect(errorName(() => sheet.insertRule("  /* nothing */ "))).toBe("SyntaxError")
    expect(errorName(() => sheet.insertRule('@import "x.css";'))).toBe("SyntaxError")
    expect(errorName(() => sheet.insertRule(".b { top: 0 }", 2))).toBe("IndexSizeError")
    expect(errorName(() => sheet.insertRule(".b { top: 0 }", -1))).toBe("IndexSizeError")
    expect(sheet.cssRules.length).toBe(1)
  })

  it("deleteRule removes the rule, detaches it and throws IndexSizeError past the end", () => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".a { top: 0 } .b { top: 1px }")
    const removed = sheet.cssRules[0]!
    sheet.deleteRule(0)
    expect(sheet.cssRules.length).toBe(1)
    expect((sheet.cssRules[0] as CSSStyleRule).selectorText).toBe(".b")
    expect(removed.parentStyleSheet).toBeNull()
    expect(errorName(() => sheet.deleteRule(1))).toBe("IndexSizeError")
    expect(errorName(() => sheet.deleteRule(-1))).toBe("IndexSizeError")
  })

  it("lists, and sends native, only what the parser keeps after a stray }", () => {
    const recording = recordingRenderer()
    const sheet = new CSSStyleSheet()
    sheet.replaceSync("} .b{} .c{}")
    expect(Array.from(sheet.cssRules, (rule) => (rule as CSSStyleRule).selectorText)).toEqual([".c"])
    document.adoptedStyleSheets = [sheet]
    expect(recording.sent()).toContainEqual(["setStyleSheet", sheet.id, ".c{}"])
  })

  it("keeps cssRules correct through interleaved inserts and deletes, the same list object", () => {
    const sheet = new CSSStyleSheet()
    const list = sheet.cssRules
    const selectors = () => Array.from({ length: list.length }, (_, index) => (list[index] as CSSStyleRule).selectorText)
    sheet.insertRule(".a { top: 0 }")
    sheet.insertRule(".b { top: 0 }", 1)
    sheet.insertRule(".c { top: 0 }", 0)
    expect(selectors()).toEqual([".c", ".a", ".b"])
    const first = list[0]!
    sheet.deleteRule(1)
    expect(selectors()).toEqual([".c", ".b"])
    expect(list[2]).toBeUndefined()
    expect(Object.keys(list)).toEqual(["0", "1"])
    expect(list[0]).toBe(first)
    expect(first.parentStyleSheet).toBe(sheet)
    sheet.insertRule(".d { top: 0 }", 1)
    expect([...list].map((rule) => (rule as CSSStyleRule).selectorText)).toEqual([".c", ".d", ".b"])
    expect(list.item(1)).toBe(list[1])
    sheet.replaceSync(".x { top: 0 }")
    expect(list).toBe(sheet.cssRules)
    expect(selectors()).toEqual([".x"])
    expect(first.parentStyleSheet).toBeNull()
    expect(sheet.sheetText()).toBe(".x { top: 0 }")
  })

  it("inserts at the front of a long sheet in linear time per call", () => {
    const sheet = new CSSStyleSheet()
    const start = performance.now()
    for (let count = 0; count < 4000; count++) sheet.insertRule(`.r${count} { top: 0 }`)
    expect(sheet.cssRules.length).toBe(4000)
    expect((sheet.cssRules[0] as CSSStyleRule).selectorText).toBe(".r3999")
    expect((sheet.cssRules[3999] as CSSStyleRule).selectorText).toBe(".r0")
    for (let count = 0; count < 4000; count++) sheet.deleteRule(0)
    expect(sheet.cssRules.length).toBe(0)
    expect(performance.now() - start).toBeLessThan(200)
  })

  it("gives every sheet its own numeric id", () => {
    const first = new CSSStyleSheet()
    const second = new CSSStyleSheet({ disabled: true })
    expect(first.id).not.toBe(second.id)
    expect(second.disabled).toBe(true)
  })
})

describe("document.adoptedStyleSheets", () => {
  it("is one array, and an assignment replaces its contents", () => {
    const first = document.adoptedStyleSheets
    const sheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [sheet]
    expect(document.adoptedStyleSheets).toBe(first)
    expect(Array.isArray(first)).toBe(true)
    expect([...first]).toEqual([sheet])
  })

  it("sends the text and the list to a renderer, and nothing when nothing changed", () => {
    const recording = recordingRenderer()
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".a { top: 0 }")
    document.adoptedStyleSheets = [sheet]
    expect(recording.sent()).toEqual([
      ["setStyleSheet", sheet.id, ".a { top: 0 }"],
      ["setAdoptedStyleSheets", [sheet.id]],
    ])
    document.adoptedStyleSheets = [sheet]
    expect(recording.sent()).toEqual([])
  })

  it("takes effect through push, splice, unshift, index and length assignment", () => {
    const recording = recordingRenderer()
    const a = new CSSStyleSheet()
    const b = new CSSStyleSheet()
    const c = new CSSStyleSheet()
    const list = document.adoptedStyleSheets
    list.push(a)
    expect(recording.sent().at(-1)).toEqual(["setAdoptedStyleSheets", [a.id]])
    list.push(b, c)
    expect(recording.sent()).toEqual([
      ["setStyleSheet", b.id, ""],
      ["setStyleSheet", c.id, ""],
      ["setAdoptedStyleSheets", [a.id, b.id, c.id]],
    ])
    list.splice(1, 1)
    expect(recording.sent()).toEqual([
      ["setAdoptedStyleSheets", [a.id, c.id]],
      ["setStyleSheet", b.id, null],
    ])
    list.unshift(b)
    expect(recording.sent().at(-1)).toEqual(["setAdoptedStyleSheets", [b.id, a.id, c.id]])
    list[0] = c
    expect(list.length).toBe(3)
    expect(recording.sent()).toEqual([
      ["setAdoptedStyleSheets", [a.id, c.id]],
      ["setStyleSheet", b.id, null],
    ])
    list.length = 1
    expect(recording.sent()).toEqual([
      ["setAdoptedStyleSheets", [c.id]],
      ["setStyleSheet", a.id, null],
    ])
    list.reverse()
    list.pop()
    expect(recording.sent()).toEqual([
      ["setAdoptedStyleSheets", []],
      ["setStyleSheet", c.id, null],
    ])
  })

  it("throws a TypeError for a value that is not a CSSStyleSheet, and changes nothing", () => {
    const sheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [sheet]
    const list = document.adoptedStyleSheets
    expect(() => list.push({} as CSSStyleSheet)).toThrow(TypeError)
    expect(() => list.splice(0, 1, sheet, "x" as unknown as CSSStyleSheet)).toThrow(TypeError)
    expect(() => {
      list[1] = null as unknown as CSSStyleSheet
    }).toThrow(TypeError)
    expect(() => {
      document.adoptedStyleSheets = [sheet, 4 as unknown as CSSStyleSheet]
    }).toThrow(TypeError)
    expect([...list]).toEqual([sheet])
  })

  it("throws RangeError for an index past the end or a longer length, TypeError for a missing value, and never changes", () => {
    const first = new CSSStyleSheet()
    const second = new CSSStyleSheet()
    document.adoptedStyleSheets = [first, second]
    const list = document.adoptedStyleSheets
    expect(() => {
      list[5] = first
    }).toThrow(RangeError)
    expect(() => {
      list.length = 3
    }).toThrow(RangeError)
    expect(() => list.fill(undefined as unknown as CSSStyleSheet)).toThrow(TypeError)
    expect(() => (list.fill as () => unknown)()).toThrow(TypeError)
    expect(() => Object.defineProperty(list, 4, { value: first })).toThrow(RangeError)
    expect([...list]).toEqual([first, second])
    expect(Object.keys(list)).toEqual(["0", "1"])
    list[2] = first
    expect(list.length).toBe(3)
  })

  it("lets only the last index be deleted, so there are no holes", () => {
    const a = new CSSStyleSheet()
    const b = new CSSStyleSheet()
    document.adoptedStyleSheets = [a, b]
    expect(() => {
      "use strict"
      delete document.adoptedStyleSheets[0]
    }).toThrow(TypeError)
    delete document.adoptedStyleSheets[1]
    expect([...document.adoptedStyleSheets]).toEqual([a])
  })

  it("sends every change of an adopted sheet's text, whole, and none for a sheet not adopted", () => {
    const recording = recordingRenderer()
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".a { top: 0 }")
    expect(recording.sent()).toEqual([])
    document.adoptedStyleSheets = [sheet]
    recording.sent()
    sheet.insertRule(".b { left: 1px }")
    expect(recording.sent()).toEqual([["setStyleSheet", sheet.id, ".b { left: 1px }\n.a { top: 0 }"]])
    sheet.deleteRule(1)
    expect(recording.sent()).toEqual([["setStyleSheet", sheet.id, ".b { left: 1px }"]])
    void sheet.replace(".c { top: 3px }")
    expect(recording.sent()).toEqual([])
  })

  it("sends one setStyleSheet per flush however many times the sheet changed, with all the rules", () => {
    const recording = recordingRenderer()
    const sheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [sheet]
    recording.sent()
    for (let index = 0; index < 1000; index++) sheet.insertRule(`.r${index} { top: ${index}px }`, index)
    sheet.deleteRule(0)
    const sent = recording.sent()
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toBe("setStyleSheet")
    expect(sent[0]![1]).toBe(sheet.id)
    expect(sent[0]![2]).toBe(sheet.sheetText())
    expect(sheet.cssRules.length).toBe(999)
    expect(sent[0]![2]).toContain(".r999 { top: 999px }")
    expect(sent[0]![2]).not.toContain(".r0 {")
  })

  it("drops a pending text for a sheet that left the adopted list before the flush", () => {
    const recording = recordingRenderer()
    const sheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [sheet]
    recording.sent()
    sheet.insertRule(".a { top: 0 }")
    document.adoptedStyleSheets = []
    expect(recording.sent()).toEqual([
      ["setAdoptedStyleSheets", []],
      ["setStyleSheet", sheet.id, null],
    ])
  })

  it("deletes a sheet natively once it is not adopted, and sends its text again when it comes back", () => {
    const recording = recordingRenderer()
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".a { top: 0 }")
    document.adoptedStyleSheets = [sheet]
    recording.sent()
    document.adoptedStyleSheets = []
    expect(recording.sent()).toEqual([
      ["setAdoptedStyleSheets", []],
      ["setStyleSheet", sheet.id, null],
    ])
    sheet.replaceSync(".a { top: 5px }")
    expect(recording.sent()).toEqual([])
    document.adoptedStyleSheets = [sheet]
    expect(recording.sent()).toEqual([
      ["setStyleSheet", sheet.id, ".a { top: 5px }"],
      ["setAdoptedStyleSheets", [sheet.id]],
    ])
  })

  it("brings a renderer that registers later up to date, once for its queues", () => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".a { top: 0 }")
    document.adoptedStyleSheets = [sheet]
    const late = recordingRenderer()
    expect(late.sent()).toEqual([
      ["setStyleSheet", sheet.id, ".a { top: 0 }"],
      ["setAdoptedStyleSheets", [sheet.id]],
    ])
  })

  it("resends everything to a queue registered after the renderer's earlier one was collected", () => {
    const collected = new Set<object>()
    class SwitchableWeakRef<T extends object> {
      constructor(private readonly target: T) {}
      deref(): T | undefined {
        return collected.has(this.target) ? undefined : this.target
      }
    }
    vi.stubGlobal("WeakRef", SwitchableWeakRef)
    try {
      const received: unknown[][] = []
      const sinkFor = (): SheetSink => ({
        setStyleSheet: (id, text) => received.push(["setStyleSheet", id, text]),
        setAdoptedStyleSheets: (ids) => received.push(["setAdoptedStyleSheets", [...ids]]),
        sheetsDirty: () => {},
      })
      const renderer = {}
      const first = sinkFor()
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(".a { top: 0 }")
      registerSheetSink(renderer, first)
      document.adoptedStyleSheets = [sheet]
      expect(received).toEqual([
        ["setStyleSheet", sheet.id, ".a { top: 0 }"],
        ["setAdoptedStyleSheets", [sheet.id]],
      ])
      received.length = 0
      collected.add(first)
      sheet.replaceSync(".a { top: 7px }")
      expect(received).toEqual([])
      registerSheetSink(renderer, sinkFor())
      expect(received).toEqual([
        ["setStyleSheet", sheet.id, ".a { top: 7px }"],
        ["setAdoptedStyleSheets", [sheet.id]],
      ])
    } finally {
      document.adoptedStyleSheets = []
      vi.unstubAllGlobals()
    }
  })

  it("sends to each renderer once, though it has two queues", () => {
    const batches: unknown[][][] = []
    const renderer: MutationHost = {
      applyBatch(bytes) {
        batches.push(decodeWireBatchForTest(bytes) as unknown[][])
        return []
      },
    }
    const first = createMutationQueue(renderer)
    const second = createMutationQueue(renderer)
    const sheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [sheet]
    first.flushMutations()
    second.flushMutations()
    expect(batches.flat().filter((op) => op[0] === "setAdoptedStyleSheets")).toHaveLength(1)
  })

  it("reaches every renderer", () => {
    const left = recordingRenderer()
    const right = recordingRenderer()
    const sheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [sheet]
    expect(left.sent().at(-1)).toEqual(["setAdoptedStyleSheets", [sheet.id]])
    expect(right.sent().at(-1)).toEqual(["setAdoptedStyleSheets", [sheet.id]])
  })

  it("counts a sheet listed twice once, at its last place", () => {
    const recording = recordingRenderer()
    const a = new CSSStyleSheet()
    const b = new CSSStyleSheet()
    document.adoptedStyleSheets = [a, b, a]
    expect(recording.sent().at(-1)).toEqual(["setAdoptedStyleSheets", [b.id, a.id]])
  })

  it("leaves a disabled sheet out until it is enabled", () => {
    const recording = recordingRenderer()
    const sheet = new CSSStyleSheet({ disabled: true })
    sheet.replaceSync(".a { top: 0 }")
    document.adoptedStyleSheets = [sheet]
    expect(recording.sent().filter((op) => op[0] === "setStyleSheet")).toEqual([])
    sheet.disabled = false
    expect(recording.sent()).toEqual([
      ["setStyleSheet", sheet.id, ".a { top: 0 }"],
      ["setAdoptedStyleSheets", [sheet.id]],
    ])
    sheet.disabled = true
    expect(recording.sent()).toEqual([
      ["setAdoptedStyleSheets", []],
      ["setStyleSheet", sheet.id, null],
    ])
  })
})

describe("globals", () => {
  it("installs CSSStyleSheet and its rule classes", () => {
    expect(globalThis.CSSStyleSheet).toBe(CSSStyleSheet)
    expect(globalThis.CSSRule).toBe(CSSRule)
    expect(globalThis.CSSStyleRule).toBe(CSSStyleRule)
    expect(globalThis.CSSRuleList).toBe(CSSRuleList)
  })
})
