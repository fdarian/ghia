import { afterEach, describe, expect, it } from "vitest"
import { createMutationQueue, type MutationHost } from "../host.js"
import { document } from "../events/window-target.js"
import { CSSRule, CSSRuleList, CSSStyleRule, CSSStyleSheet } from "../css/index.js"
import { splitRules } from "../css/rules.js"
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
    expect(splitRules(".a { top: 0 ;; .b { left: 0 }").map((rule) => rule.text)).toEqual([".a { top: 0 ;; .b { left: 0 }"])
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
    const { sent } = recordingRenderer()
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".a { top: 0 }")
    document.adoptedStyleSheets = [sheet]
    expect(sent()).toEqual([
      ["setStyleSheet", sheet.id, ".a { top: 0 }"],
      ["setAdoptedStyleSheets", [sheet.id]],
    ])
    document.adoptedStyleSheets = [sheet]
    expect(sent()).toEqual([])
  })

  it("takes effect through push, splice, unshift, index and length assignment", () => {
    const { sent } = recordingRenderer()
    const [a, b, c] = [new CSSStyleSheet(), new CSSStyleSheet(), new CSSStyleSheet()]
    const list = document.adoptedStyleSheets
    list.push(a!)
    expect(sent().at(-1)).toEqual(["setAdoptedStyleSheets", [a!.id]])
    list.push(b!, c!)
    expect(sent()).toEqual([
      ["setStyleSheet", b!.id, ""],
      ["setStyleSheet", c!.id, ""],
      ["setAdoptedStyleSheets", [a!.id, b!.id, c!.id]],
    ])
    list.splice(1, 1)
    expect(sent()).toEqual([
      ["setAdoptedStyleSheets", [a!.id, c!.id]],
      ["setStyleSheet", b!.id, null],
    ])
    list.unshift(b!)
    expect(sent().at(-1)).toEqual(["setAdoptedStyleSheets", [b!.id, a!.id, c!.id]])
    list[0] = c!
    expect(list.length).toBe(3)
    expect(sent()).toEqual([
      ["setAdoptedStyleSheets", [a!.id, c!.id]],
      ["setStyleSheet", b!.id, null],
    ])
    list.length = 1
    expect(sent()).toEqual([
      ["setAdoptedStyleSheets", [c!.id]],
      ["setStyleSheet", a!.id, null],
    ])
    list.reverse()
    list.pop()
    expect(sent()).toEqual([
      ["setAdoptedStyleSheets", []],
      ["setStyleSheet", c!.id, null],
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

  it("lets only the last index be deleted, so there are no holes", () => {
    const [a, b] = [new CSSStyleSheet(), new CSSStyleSheet()]
    document.adoptedStyleSheets = [a, b]
    expect(() => {
      "use strict"
      delete document.adoptedStyleSheets[0]
    }).toThrow(TypeError)
    delete document.adoptedStyleSheets[1]
    expect([...document.adoptedStyleSheets]).toEqual([a])
  })

  it("sends every change of an adopted sheet's text, whole, and none for a sheet not adopted", () => {
    const { sent } = recordingRenderer()
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".a { top: 0 }")
    expect(sent()).toEqual([])
    document.adoptedStyleSheets = [sheet]
    sent()
    sheet.insertRule(".b { left: 1px }")
    expect(sent()).toEqual([["setStyleSheet", sheet.id, ".b { left: 1px }\n.a { top: 0 }"]])
    sheet.deleteRule(1)
    expect(sent()).toEqual([["setStyleSheet", sheet.id, ".b { left: 1px }"]])
    void sheet.replace(".c { top: 3px }")
    expect(sent()).toEqual([])
  })

  it("deletes a sheet natively once it is not adopted, and sends its text again when it comes back", () => {
    const { sent } = recordingRenderer()
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".a { top: 0 }")
    document.adoptedStyleSheets = [sheet]
    sent()
    document.adoptedStyleSheets = []
    expect(sent()).toEqual([
      ["setAdoptedStyleSheets", []],
      ["setStyleSheet", sheet.id, null],
    ])
    sheet.replaceSync(".a { top: 5px }")
    expect(sent()).toEqual([])
    document.adoptedStyleSheets = [sheet]
    expect(sent()).toEqual([
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
    const { sent } = recordingRenderer()
    const [a, b] = [new CSSStyleSheet(), new CSSStyleSheet()]
    document.adoptedStyleSheets = [a, b, a]
    expect(sent().at(-1)).toEqual(["setAdoptedStyleSheets", [b.id, a.id]])
  })

  it("leaves a disabled sheet out until it is enabled", () => {
    const { sent } = recordingRenderer()
    const sheet = new CSSStyleSheet({ disabled: true })
    sheet.replaceSync(".a { top: 0 }")
    document.adoptedStyleSheets = [sheet]
    expect(sent().filter((op) => op[0] === "setStyleSheet")).toEqual([])
    sheet.disabled = false
    expect(sent()).toEqual([
      ["setStyleSheet", sheet.id, ".a { top: 0 }"],
      ["setAdoptedStyleSheets", [sheet.id]],
    ])
    sheet.disabled = true
    expect(sent()).toEqual([
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
