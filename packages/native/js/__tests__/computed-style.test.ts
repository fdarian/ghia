import { describe, expect, it } from "vitest"
import { HOST_BINDING } from "../bounds.js"
import { COMPUTED_STYLE_PROPERTIES, getComputedStyle } from "../computed-style.js"
import type { MutationRenderer, NativeRenderer } from "../host.js"

function fakeElement(id: number, pairs: string[] | null, mounted = true) {
  const reads: [number, boolean][] = []
  const renderer = {
    applyBatch: () => [],
    getComputedStyle(elementId: number, pseudo: boolean) {
      reads.push([elementId, pseudo])
      return pairs
    },
  } as unknown as NativeRenderer
  const element = {
    id,
    [HOST_BINDING]: () => (mounted ? { renderer, mutations: {} as MutationRenderer } : undefined),
  }
  return { element, reads }
}

describe("getComputedStyle", () => {
  it("reads camelCase members and kebab-case names from one native record", async () => {
    const { element, reads } = fakeElement(3, ["font-size", "20px", "padding-inline-start", "4px", "--gap", "12px"])
    const style = getComputedStyle(element)
    expect([style.fontSize, style.paddingInlineStart, style.getPropertyValue("font-size"), style.getPropertyValue("--gap")]).toEqual([
      "20px",
      "4px",
      "20px",
      "12px",
    ])
    expect(style.getPropertyValue("--missing")).toBe("")
    expect(style.width).toBe("")
    expect(reads).toEqual([[3, false]])
    await Promise.resolve()
    expect(style.fontSize).toBe("20px")
    expect(reads).toHaveLength(2)
  })

  it("asks for an absent pseudo-element for ::before and ::after, and reads empty for any other", () => {
    const { element, reads } = fakeElement(3, ["content", "none"])
    expect(getComputedStyle(element, "::before").content).toBe("none")
    expect(getComputedStyle(element, ":after").content).toBe("none")
    expect(getComputedStyle(element, "::marker").content).toBe("")
    expect(reads).toEqual([[3, true]])
  })

  it("reads empty for an element that is not mounted or not in the document", () => {
    const unmounted = fakeElement(3, ["display", "block"], false)
    expect(getComputedStyle(unmounted.element).display).toBe("")
    expect(unmounted.reads).toEqual([])
    const detached = fakeElement(3, null)
    expect(getComputedStyle(detached.element).display).toBe("")
  })

  it("throws for what is not an element, and for a write", () => {
    expect(() => getComputedStyle({} as never)).toThrow(TypeError)
    const { element } = fakeElement(3, [])
    expect(() => getComputedStyle(element).setProperty("width", "1px")).toThrow(
      expect.objectContaining({ name: "NoModificationAllowedError" })
    )
    expect(getComputedStyle(element).length).toBe(COMPUTED_STYLE_PROPERTIES.length)
  })
})
