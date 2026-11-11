import { afterEach, describe, expect, it } from "vitest"
import "../dom-globals.js"
import { document, installElementSource } from "../events/window-target.js"
import { createRendererState } from "../renderer-state.js"
import type { NativeRenderer } from "../host.js"

class FakeWindow {
  hits: number[] = []
  asked: Array<[number, number]> = []

  applyBatch(): number[] {
    return []
  }

  getElementsAt(x: number, y: number): number[] {
    this.asked.push([x, y])
    return this.hits
  }
}

describe("document.elementFromPoint and elementsFromPoint", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function mountWindow(elements: Record<number, object>): FakeWindow {
    const fake = new FakeWindow()
    const renderer = fake as unknown as NativeRenderer
    const binding = createRendererState(renderer).attach()
    cleanups.push(() => binding.detach(), installElementSource(fake, (id) => elements[id]))
    return fake
  }

  it("throws before a root is mounted", () => {
    expect(() => document.elementsFromPoint(1, 1)).toThrow(/mounted/)
    expect(() => document.elementFromPoint(1, 1)).toThrow(/mounted/)
  })

  it("lists the elements native hit tests, topmost first, as the objects a ref gives", () => {
    const [top, body, html] = [{ name: "top" }, { name: "body" }, { name: "html" }]
    const fake = mountWindow({ 3: top, 2: body, 1: html })
    fake.hits = [3, 2, 1]
    expect(document.elementsFromPoint(12.5, 40)).toEqual([top, body, html])
    expect(document.elementFromPoint(12.5, 40)).toBe(top)
    expect(fake.asked).toEqual([
      [12.5, 40],
      [12.5, 40],
    ])
  })

  it("is empty, and null for elementFromPoint, outside the window", () => {
    mountWindow({})
    expect(document.elementsFromPoint(-1, 5000)).toEqual([])
    expect(document.elementFromPoint(-1, 5000)).toBeNull()
  })

  it("rejects a coordinate that is not a finite number, as a browser does", () => {
    mountWindow({})
    expect(() => document.elementsFromPoint(Number.NaN, 0)).toThrow(TypeError)
    expect(() => document.elementFromPoint(0, Number.POSITIVE_INFINITY)).toThrow(TypeError)
  })

  it("throws for an element the root has dropped", () => {
    const fake = mountWindow({})
    fake.hits = [9]
    expect(() => document.elementsFromPoint(0, 0)).toThrow("Element 9")
  })
})
