import { useState } from "react"
import { describe, expect, it } from "vitest"
import { createPortal } from "../reconciler/portal.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Screen({ items, mounted = true }: { items: string[]; mounted?: boolean }) {
  const [layer, setLayer] = useState<PublicInstance | null>(null)
  return (
    <div style={{ width: 200, height: 200 }}>
      <div testId="layer" ref={setLayer} style={{ width: 100, height: 100 }} />
      <div testId="lexical-parent" style={{ width: 100, height: 20 }}>
        {mounted &&
          layer &&
          createPortal(
            items.map((item) => (
              <div key={item} testId={`item-${item}`}>
                {item}
              </div>
            )),
            layer
          )}
      </div>
    </div>
  )
}

describeNative("createPortal", () => {
  it("mounts its children under the target element, not the lexical parent", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      render(<Screen items={["a", "b"]} />)

      const layer = renderer.findByTestId("layer")!
      const a = renderer.findByTestId("item-a")!
      const b = renderer.findByTestId("item-b")!

      expect(layer.children).toEqual([a.id, b.id])
      expect(a.parentId).toBe(layer.id)
      expect(renderer.findByTestId("lexical-parent")!.children).toEqual([])
      expect(renderer.getPaintedText()).toEqual(["a", "b"])
    } finally {
      unmount()
    }
  })

  it("places a child React inserts before another one in that order", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      render(<Screen items={["b", "c"]} />)
      const b = renderer.findByTestId("item-b")!
      const c = renderer.findByTestId("item-c")!

      render(<Screen items={["a", "b", "c"]} />)
      render(<Screen items={["a", "b", "x", "c"]} />)

      const layer = renderer.findByTestId("layer")!
      const ids = (names: string[]) => names.map((name) => renderer.findByTestId(`item-${name}`)!.id)
      expect(layer.children).toEqual(ids(["a", "b", "x", "c"]))
      // Neighbours are updated in place, not remounted.
      expect(renderer.findByTestId("item-b")!.id).toBe(b.id)
      expect(renderer.findByTestId("item-c")!.id).toBe(c.id)
    } finally {
      unmount()
    }
  })

  it("keeps the portal mounted across re-renders", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      render(<Screen items={["a"]} />)
      const first = renderer.findByTestId("item-a")!.id

      render(<Screen items={["a"]} />)
      render(<Screen items={["a"]} />)

      expect(renderer.findByTestId("item-a")!.id).toBe(first)
    } finally {
      unmount()
    }
  })

  it("frees the portal's elements when it unmounts", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      render(<Screen items={["a", "b"]} mounted={false} />)
      const without = renderer.getRetainedElementCount()

      render(<Screen items={["a", "b"]} />)
      expect(renderer.getRetainedElementCount()).toBeGreaterThan(without)

      render(<Screen items={["a", "b"]} mounted={false} />)
      expect(renderer.findByTestId("item-a")).toBeUndefined()
      expect(renderer.findByTestId("layer")!.children).toEqual([])
      expect(renderer.getRetainedElementCount()).toBe(without)
    } finally {
      unmount()
    }
  })
})
