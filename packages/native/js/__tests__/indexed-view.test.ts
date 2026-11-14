import { describe, expect, it } from "vitest"
import { indexOfKey, indexedView, splitOnSpaces } from "../dom/indexed-view.js"
import { bumpTreeVersion, treeVersion } from "../dom/tree-version.js"

class Letters {
  readonly items = ["a", "b"]
  get length(): number {
    return this.items.length
  }
  item(index: number): string | null {
    return this.items[index] ?? null
  }
}

const source = (letters: Letters) => ({ length: () => letters.length, at: (index: number) => letters.item(index) ?? undefined })

describe("indexOfKey", () => {
  it("accepts canonical array indices only", () => {
    expect(indexOfKey("0")).toBe(0)
    expect(indexOfKey("12")).toBe(12)
    for (const key of ["01", "-1", "1.5", "a", "", "length", Symbol.iterator]) expect(indexOfKey(key)).toBeUndefined()
  })
})

describe("splitOnSpaces", () => {
  it("splits on HTML whitespace and drops empty tokens", () => {
    expect(splitOnSpaces(" a\tb\n\nc\f d\r")).toEqual(["a", "b", "c", "d"])
    expect(splitOnSpaces("")).toEqual([])
  })
})

describe("indexedView", () => {
  it("reads the indices from the source and the rest from the target", () => {
    const letters = new Letters()
    const view = indexedView(letters, source(letters))
    expect((view as unknown as string[])[0]).toBe("a")
    expect(view.length).toBe(2)
    expect(0 in view).toBe(true)
    expect(2 in view).toBe(false)
    expect(Object.keys(view)).toEqual(["0", "1", "items"])
    letters.items.push("c")
    expect((view as unknown as string[])[2]).toBe("c")
  })

  it("refuses to assign an index", () => {
    const letters = new Letters()
    const view = indexedView(letters, source(letters)) as unknown as Record<string, unknown>
    expect(Reflect.set(view, "0", "x")).toBe(false)
    expect(Reflect.set(view, "own", "x")).toBe(true)
  })

  it("looks a name up only for a string the target has no member of", () => {
    const letters = new Letters()
    const asked: string[] = []
    const view = indexedView(letters, source(letters), {
      get: (name) => (asked.push(name), name === "b" ? "found" : undefined),
      has: (name) => name === "b",
    }) as unknown as Record<string | symbol, unknown>
    expect(view.b).toBe("found")
    expect(view.length).toBe(2)
    expect(view.item).toBe(Letters.prototype.item)
    expect(view[Symbol.toPrimitive]).toBeUndefined()
    expect("b" in view).toBe(true)
    expect("z" in view).toBe(false)
    expect(asked).toEqual(["b"])
  })
})

describe("treeVersion", () => {
  it("moves on every bump", () => {
    const before = treeVersion()
    bumpTreeVersion()
    expect(treeVersion()).toBe(before + 1)
  })
})
