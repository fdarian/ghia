import fs from "fs"
import { describe, expect, it } from "vitest"
import { DIRECT_COVERS, overlaps } from "../style-covers.js"

const camelCase = (name: string) => name.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())

describe("style covers", () => {
  it("are the covers table of the native side", () => {
    const source = fs.readFileSync(new URL("../../src/css/covers.rs", import.meta.url), "utf8")
    const start = source.indexOf("\ncovers! {")
    expect(start, "the covers! table").toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf("\n}\n", start))
    const native: Record<string, string[]> = {}
    for (const entry of block.matchAll(/(\w+)\s*=>\s*\[([^\]]*)\]/g)) {
      native[camelCase(entry[1])] = entry[2]
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .map(camelCase)
    }
    expect(Object.keys(native).length).toBeGreaterThan(30)
    expect(DIRECT_COVERS).toEqual(native)
  })

  it("make a shorthand overlap what it covers, and two shorthands that share a longhand", () => {
    expect(overlaps("padding", "paddingTop")).toBe(true)
    expect(overlaps("paddingTop", "padding")).toBe(true)
    expect(overlaps("border", "borderTopColor")).toBe(true)
    expect(overlaps("borderTop", "borderWidth")).toBe(true)
    expect(overlaps("borderWidth", "borderTop")).toBe(true)
    expect(overlaps("width", "width")).toBe(true)
    expect(overlaps("paddingTop", "paddingBottom")).toBe(false)
    expect(overlaps("borderTopWidth", "borderColor")).toBe(false)
    expect(overlaps("width", "height")).toBe(false)
  })
})
