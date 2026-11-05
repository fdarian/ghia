import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Op = [string, ...unknown[]]

/** Every op that crossed into Rust, per `applyBatch` call. */
function recordBatches(renderer: { applyBatch(json: string): unknown }) {
  const batches: Op[][] = []
  const original = renderer.applyBatch.bind(renderer)
  renderer.applyBatch = (json: string) => {
    batches.push(JSON.parse(json) as Op[])
    return original(json)
  }
  return {
    batches,
    ops: (name: string) => batches.flat().filter((op) => op[0] === name),
    clear: () => {
      batches.length = 0
    },
  }
}

describeNative("style and custom prop updates", () => {
  it("sends nothing when a re-render rebuilds an equal style object", () => {
    const { render, renderer, unmount } = createTestRoot()
    const view = (color: string) => (
      <div style={{ width: 100, height: 40, backgroundColor: "#111", hover: { backgroundColor: color } }}>
        <text style={{ color: "#fff" }}>hello</text>
      </div>
    )
    try {
      render(view("#222"))
      const sent = recordBatches(renderer)

      render(view("#222"))
      render(view("#222"))

      expect(sent.batches).toEqual([])
    } finally {
      unmount()
    }
  })

  it("queues only the ops of the two rows that changed when a list of 50 rows re-renders", () => {
    const { render, renderer, unmount } = createTestRoot()
    const view = (selected: number) => (
      <div>
        {Array.from({ length: 50 }, (_, index) => (
          <div
            key={index}
            style={{ height: 20, borderBottom: "1px solid #eee", backgroundColor: selected === index ? "#dbeafe" : undefined }}
          >
            <text style={{ color: selected === index ? "#000" : "#111" }}>row {index}</text>
          </div>
        ))}
      </div>
    )
    try {
      render(view(0))
      const sent = recordBatches(renderer)

      render(view(7))

      expect(sent.ops("setStyle")).toHaveLength(4)
      expect(sent.batches.flat()).toHaveLength(4)
    } finally {
      unmount()
    }
  })

  it("sends only the element whose style changed", () => {
    const { render, renderer, unmount } = createTestRoot()
    const view = (hovered: string) => (
      <div style={{ width: 100, height: 40 }}>
        <div style={{ height: 10, backgroundColor: "#111" }} />
        <div style={{ height: 10, backgroundColor: hovered }} />
      </div>
    )
    try {
      render(view("#222"))
      const sent = recordBatches(renderer)

      render(view("#333"))

      const styles = sent.ops("setStyle")
      expect(styles).toHaveLength(1)
      expect(styles[0]![2]).toEqual({ height: 10, backgroundColor: "#333" })
    } finally {
      unmount()
    }
  })

  it("reaches a changed nested state style", () => {
    const { render, renderer, unmount } = createTestRoot()
    const view = (hover: string) => (
      <div style={{ width: 100, height: 40, hover: { backgroundColor: hover } }} />
    )
    try {
      render(view("#222"))
      const sent = recordBatches(renderer)

      render(view("#444"))

      expect(sent.ops("setStyle")).toHaveLength(1)
    } finally {
      unmount()
    }
  })

  it("resets a style that was removed", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      render(<div style={{ width: 100, height: 40, backgroundColor: "#111" }} />)
      const sent = recordBatches(renderer)

      render(<div />)

      const styles = sent.ops("setStyle")
      expect(styles).toHaveLength(1)
      expect(styles[0]![2]).toEqual({})
    } finally {
      unmount()
    }
  })

  it("treats an undefined style value as absent", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      render(<div style={{ width: 100, height: 40, backgroundColor: undefined }} />)
      const sent = recordBatches(renderer)

      render(<div style={{ width: 100, height: 40 }} />)

      expect(sent.batches).toEqual([])
    } finally {
      unmount()
    }
  })

  it("sends a custom prop once per change, not once per render", () => {
    const { render, renderer, unmount } = createTestRoot()
    const view = (label: string, handler: () => void) => (
      <div
        aria-label={label}
        highlight={{ query: "needle" }}
        onClick={handler}
        style={{ width: 100, height: 40 }}
      />
    )
    try {
      render(view("one", () => {}))
      const sent = recordBatches(renderer)

      // A new handler and a new but equal `highlight` object on every render.
      render(view("one", () => {}))
      expect(sent.ops("setCustomProp")).toEqual([])

      render(view("two", () => {}))
      const props = sent.ops("setCustomProp")
      expect(props).toHaveLength(1)
      expect(props[0]!.slice(2)).toEqual(["aria-label", "two"])
    } finally {
      unmount()
    }
  })

  it("clears a custom prop that is no longer passed", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      render(<div aria-label="one" style={{ width: 100, height: 40 }} />)
      const sent = recordBatches(renderer)

      render(<div style={{ width: 100, height: 40 }} />)

      const props = sent.ops("setCustomProp")
      expect(props).toHaveLength(1)
      expect(props[0]!.slice(2)).toEqual(["aria-label", null])
    } finally {
      unmount()
    }
  })
})
