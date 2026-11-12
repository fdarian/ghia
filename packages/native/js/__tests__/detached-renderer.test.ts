import { describe, expect, it } from "vitest"
import { detachRenderer } from "../detached-renderer.js"

function liveRenderer() {
  const calls: string[] = []
  return {
    calls,
    getElementBounds: (id: number) => {
      calls.push(`bounds ${id}`)
      return { x: 1, y: 2, width: 3, height: 4 }
    },
    focusElement: (id: number) => calls.push(`focus ${id}`),
    applyBatch: () => {
      calls.push("batch")
      return [1]
    },
    getFocusedElementId: () => 7,
    simulateKeyDown: () => {
      throw new Error("window is gone")
    },
  }
}

describe("detachRenderer", () => {
  it("answers the element-facing methods as for a node that is not in a document", () => {
    const renderer = liveRenderer()
    detachRenderer(renderer)

    expect(renderer.getElementBounds(1)).toBeNull()
    expect(renderer.focusElement(1)).toBeUndefined()
    expect(renderer.applyBatch()).toEqual([])
    expect(renderer.getFocusedElementId()).toBeNull()
    expect(renderer.calls).toEqual([])
  })

  it("leaves the methods only a test or an app calls alone", () => {
    const renderer = liveRenderer()
    detachRenderer(renderer)

    expect(() => renderer.simulateKeyDown()).toThrow("window is gone")
  })

  it("does not add a method the renderer lacks, which callers read as unsupported", () => {
    const renderer = {}
    detachRenderer(renderer)

    expect(Reflect.has(renderer, "getComputedStyle")).toBe(false)
  })

  it("answers for a prototype method too, and a second call changes nothing", () => {
    class Renderer {
      getElementBounds() {
        return { x: 0, y: 0, width: 1, height: 1 }
      }
    }
    const renderer = new Renderer()
    detachRenderer(renderer)
    detachRenderer(renderer)

    expect(renderer.getElementBounds()).toBeNull()
    expect(new Renderer().getElementBounds()).not.toBeNull()
  })
})
