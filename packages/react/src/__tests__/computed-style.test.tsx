/// `getComputedStyle` of `@ghia/native` against what headless Chrome reports for the same tree.
///
/// `fixtures/computed-style-oracle.html` is the page and `fixtures/computed-style-oracle.json` what Chrome
/// reports for it (regenerate with `fixtures/computed-style-oracle.sh`): every property of the set for the
/// elements each case names, and for the `::before` and `::after` of an element that has none. The tree is
/// rendered here with the same styles and every value is compared. What Ghia does not do the same is listed
/// in `KNOWN_DEVIATIONS`, with the value Chrome has and the one Ghia gives.

import fs from "fs"
import path from "path"
import type { CSSProperties, ReactNode } from "react"
import { fileURLToPath } from "url"
import { describe, expect, it } from "vitest"
import { COMPUTED_STYLE_PROPERTIES, getComputedStyle } from "@ghia/native/host"
import type { PublicInstance } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Style = Record<string, unknown>
type Node = { id: string; style: Style; children: Node[] }
type Values = Record<string, string>
type Case = {
  scene: Node | null
  values: Record<string, Values>
  pseudo: Record<string, Record<string, Values>>
  custom: string[]
}

const ORACLE: { properties: string[]; cases: Record<string, Case> } = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/computed-style-oracle.json"),
    "utf8"
  )
)

/** Case, then element, then property: Chrome's value and the one Ghia gives. */
const KNOWN_DEVIATIONS: Record<string, Record<string, Record<string, [string, string]>>> = {
  // A percentage padding is of the containing block's width in Chrome (10% of 400) and Ghia lays it out as a
  // percentage of its height (10% of 300); the value read is the one laid out.
  percentages: { a: { "padding-top": ["40px", "30px"], "padding-block-start": ["40px", "30px"] } },
  // The page's `*` rule gives elements `border-box` and does not reach a pseudo-element, which is `content-box`;
  // Ghia has no other box sizing.
  pseudo: { "a::before": { "box-sizing": ["content-box", "border-box"] }, "a::after": { "box-sizing": ["content-box", "border-box"] } },
}

/** The page and the module list the same properties, so a property cannot be added to one alone. */
describe("the property set", () => {
  it("is the one the oracle page reads", () => {
    expect([...COMPUTED_STYLE_PROPERTIES]).toEqual(ORACLE.properties)
  })
})

const NUMBER = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g

/** Equal text, with the numbers of a matrix to the 5th digit: Chrome computes it in doubles, Ghia in floats. */
function same(actual: string, expected: string): boolean {
  if (actual === expected) return true
  if (actual.replace(NUMBER, "#") !== expected.replace(NUMBER, "#")) return false
  const left = actual.match(NUMBER) ?? []
  const right = expected.match(NUMBER) ?? []
  return left.every((value, index) => Math.abs(Number(value) - Number(right[index])) < 1e-4)
}

function element(node: Node, refs: Map<string, PublicInstance>): ReactNode {
  const ref = (instance: PublicInstance | null) => {
    if (instance) refs.set(node.id, instance)
  }
  const style: Style = { ...node.style }
  for (const key of ["zIndex", "opacity"]) if (key in style) style[key] = Number(style[key])
  return (
    <div key={node.id} ref={ref} testId={node.id} style={style as CSSProperties}>
      {node.children.map((child) => element(child, refs))}
    </div>
  )
}

function mount(scene: Node) {
  const root = createTestRoot()
  const refs = new Map<string, PublicInstance>()
  root.render(element(scene, refs))
  root.renderer.dispatchNativeEvents()
  const ref = (id: string): PublicInstance => {
    const found = refs.get(id)
    if (!found) throw new Error(`No element ${id}`)
    return found
  }
  return { ...root, ref }
}

function read(style: ReturnType<typeof getComputedStyle>, names: string[]): Values {
  const values: Values = {}
  for (const name of names) values[name] = style.getPropertyValue(name)
  return values
}

function compare(label: string, actual: Values, expected: Values, deviations: Record<string, [string, string]> = {}) {
  const mismatches: string[] = []
  for (const [name, value] of Object.entries(expected)) {
    const known = deviations[name]
    if (known) {
      expect(actual[name], `${label} ${name} (known deviation)`).toBe(known[1])
      expect(value, `${label} ${name} (Chrome)`).toBe(known[0])
      continue
    }
    if (!same(actual[name] ?? "", value)) mismatches.push(`${name}: ghia ${JSON.stringify(actual[name])}, chrome ${JSON.stringify(value)}`)
  }
  expect(mismatches, label).toEqual([])
}

describeNative("getComputedStyle against Chrome", () => {
  for (const [name, data] of Object.entries(ORACLE.cases)) {
    if (!data.scene) continue
    const scene = data.scene
    it(name, () => {
      const t = mount(scene)
      try {
        for (const [id, expected] of Object.entries(data.values)) {
          const style = getComputedStyle(t.ref(id))
          compare(`${name} / ${id}`, read(style, [...ORACLE.properties, ...data.custom]), expected, KNOWN_DEVIATIONS[name]?.[id])
        }
        for (const [id, pseudos] of Object.entries(data.pseudo)) {
          for (const [pseudo, expected] of Object.entries(pseudos)) {
            const style = getComputedStyle(t.ref(id), pseudo)
            compare(`${name} / ${id}${pseudo}`, read(style, ORACLE.properties), expected, KNOWN_DEVIATIONS[name]?.[`${id}${pseudo}`])
          }
        }
      } finally {
        t.unmount()
      }
    })
  }
})

describeNative("an element that is not in the document", () => {
  it("reads empty for every property, as Chrome does", () => {
    const refs = new Map<string, PublicInstance>()
    const t = createTestRoot()
    const scene = (child: boolean) =>
      element({ id: "root", style: {}, children: child ? [{ id: "a", style: { width: 10 }, children: [] }] : [] }, refs)
    t.render(scene(true))
    const instance = refs.get("a") as PublicInstance
    expect(getComputedStyle(instance).width).toBe("10px")
    t.render(scene(false))
    const style = getComputedStyle(instance)
    expect(read(style, ORACLE.properties)).toEqual(Object.fromEntries(ORACLE.properties.map((name) => [name, ""])))
    expect(style.display).toBe("")
  })
})

describeNative("the declaration", () => {
  it("is live: a write and a read in one turn see the write", () => {
    const refs = new Map<string, PublicInstance>()
    const t = createTestRoot()
    t.render(element({ id: "a", style: { width: 10, height: 10 }, children: [] }, refs))
    const style = getComputedStyle(refs.get("a") as PublicInstance)
    expect(style.width).toBe("10px")
    t.render(element({ id: "a", style: { width: 30, height: 10 }, children: [] }, refs))
    expect(style.width).toBe("30px")
    t.unmount()
  })

  it("reads every property of a burst from one native read", () => {
    const refs = new Map<string, PublicInstance>()
    const t = createTestRoot()
    t.render(element({ id: "a", style: { width: 10, height: 10 }, children: [] }, refs))
    let reads = 0
    const native = t.renderer as unknown as { getComputedStyle: (id: number, pseudo: boolean) => string[] | null }
    const original = native.getComputedStyle.bind(t.renderer)
    native.getComputedStyle = (id, pseudo) => {
      reads++
      return original(id, pseudo)
    }
    const style = getComputedStyle(refs.get("a") as PublicInstance)
    expect([style.width, style.height, style.display, style.getPropertyValue("padding-top")]).toEqual(["10px", "10px", "block", "0px"])
    expect(reads).toBe(1)
    t.unmount()
  })

  it("is read only, and has the length and items of a CSSStyleDeclaration", () => {
    const refs = new Map<string, PublicInstance>()
    const t = createTestRoot()
    t.render(element({ id: "a", style: {}, children: [] }, refs))
    const style = getComputedStyle(refs.get("a") as PublicInstance)
    expect(() => style.setProperty("width", "1px")).toThrow(expect.objectContaining({ name: "NoModificationAllowedError" }))
    expect(() => style.removeProperty("width")).toThrow(expect.objectContaining({ name: "NoModificationAllowedError" }))
    expect(() => {
      ;(style as unknown as { width: string }).width = "1px"
    }).toThrow(expect.objectContaining({ name: "NoModificationAllowedError" }))
    expect(style.length).toBe(COMPUTED_STYLE_PROPERTIES.length)
    expect(style.item(0)).toBe(COMPUTED_STYLE_PROPERTIES[0])
    expect(style.item(100000)).toBe("")
    expect(style.cssText).toBe("")
    expect(style.getPropertyValue("mix-blend-mode")).toBe("")
    expect(style.getPropertyValue("WIDTH")).toBe(style.width)
    t.unmount()
  })

  it("reads the values a transition has at the instant of the read, and moves nothing", async () => {
    const refs = new Map<string, PublicInstance>()
    const t = createTestRoot()
    const scene = (opacity: number) =>
      element({ id: "a", style: { width: 100, height: 20, opacity, transition: "opacity 1s linear" }, children: [] }, refs)
    t.renderer.clockPause()
    t.render(scene(1))
    const style = getComputedStyle(refs.get("a") as PublicInstance)
    expect(style.opacity).toBe("1")
    t.render(scene(0))
    // Chrome has started the transition when it styles the element for this read, at its start value.
    expect(style.opacity).toBe("1")
    // Frames come in other turns of the event loop, which end the record the declaration keeps.
    await Promise.resolve()
    t.renderer.clockFastForward(500)
    t.renderer.drawFrame()
    expect(Number(style.opacity)).toBeCloseTo(0.5, 1)
    await Promise.resolve()
    t.renderer.clockFastForward(600)
    t.renderer.drawFrame()
    expect(style.opacity).toBe("0")
    t.unmount()
  })
})

describeNative("var()", () => {
  it("is substituted in the values an element reads and in the ones it passes down", () => {
    const t = mount({
      id: "a",
      style: { "--s": "30px", "--c": "red", fontSize: "var(--s)", minWidth: "2em", color: "var(--c)", width: 200 },
      children: [{ id: "b", style: { minWidth: "1em" }, children: [{ id: "c", style: { minWidth: "1em" }, children: [] }] }],
    })
    try {
      const own = getComputedStyle(t.ref("a"))
      expect([own.fontSize, own.minWidth, own.color]).toEqual(["30px", "60px", "rgb(255, 0, 0)"])
      for (const id of ["b", "c"]) {
        const inherited = getComputedStyle(t.ref(id))
        expect([inherited.fontSize, inherited.minWidth, inherited.color]).toEqual(["30px", "30px", "rgb(255, 0, 0)"])
      }
    } finally {
      t.unmount()
    }
  })
})
