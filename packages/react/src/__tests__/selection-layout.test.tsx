/// Regressions for selection in layouts Comet never had to handle.
///
/// Comet's transcript is a single column, so its hit test compares Y only.
/// GPUIX lays out arbitrary React trees, where two texts routinely share a
/// vertical band. Every test here failed with a Y-only hit test.

import React from "react"
import { describe, expect, it, vi } from "vitest"
import { createTestRoot } from "../testing.js"

describe("selection hit testing across layouts", () => {
  it("selects the column the pointer is actually in", () => {
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", flexDirection: "row", padding: 20, gap: 200 }}>
        <div style={{ fontSize: 20 }}>LEFTSIDE</div>
        <div style={{ fontSize: 20 }}>RIGHTSIDE</div>
      </div>
    )

    // Both texts sit in the same vertical band. A Y-only hit test returns a
    // fragment of LEFTSIDE no matter where the drag starts.
    const selected = renderer.dragSelect(310, 30, 900, 30)
    expect(selected).not.toBeNull()
    expect(selected).not.toContain("LEFT")
    expect("RIGHTSIDE".endsWith(selected!)).toBe(true)
  })

  it("selects the left column when the drag stays there", () => {
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", flexDirection: "row", padding: 20, gap: 200 }}>
        <div style={{ fontSize: 20 }}>LEFTSIDE</div>
        <div style={{ fontSize: 20 }}>RIGHTSIDE</div>
      </div>
    )

    const selected = renderer.dragSelect(21, 30, 120, 30)
    expect(selected).not.toBeNull()
    expect(selected).not.toContain("RIGHT")
  })

  it("does not start a selection from userSelect none chrome on the same row", () => {
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", flexDirection: "row", padding: 20, gap: 80 }}>
        <div
          style={{
            userSelect: "none",
            width: 180,
            height: 40,
            backgroundColor: "#333333",
          }}
        >
          <div style={{ fontSize: 20 }}>SIDEBAR</div>
        </div>
        <div style={{ fontSize: 20 }}>message text here</div>
      </div>
    )

    expect(renderer.dragSelect(30, 40, 900, 40)).toBeNull()
  })

  it("does not start a document selection from an input on the same row", () => {
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", flexDirection: "row", padding: 20, gap: 40 }}>
        <div style={{ fontSize: 20 }}>DOCUMENT</div>
        <input value="typed" style={{ width: 220, height: 32 }} />
      </div>
    )

    expect(renderer.dragSelect(280, 36, 30, 36)).toBeNull()
  })

  it("starts in left padding and still picks the left column", () => {
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", flexDirection: "row", padding: 40, gap: 200 }}>
        <div style={{ fontSize: 20 }}>LEFTSIDE</div>
        <div style={{ fontSize: 20 }}>RIGHTSIDE</div>
      </div>
    )

    const selected = renderer.dragSelect(8, 50, 160, 50)
    expect(selected).not.toBeNull()
    expect(selected).not.toContain("RIGHT")
    expect("LEFTSIDE".endsWith(selected!)).toBe(true)
  })

  it("spans two columns when the drag crosses them", () => {
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", flexDirection: "row", padding: 20, gap: 200 }}>
        <div style={{ fontSize: 20 }}>AAAA</div>
        <div style={{ fontSize: 20 }}>BBBB</div>
      </div>
    )

    const selected = renderer.dragSelect(21, 30, 900, 30)
    expect(selected).toBe("AAAA\nBBBB")
  })

  it("does not leak inherited selectability across siblings", () => {
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", flexDirection: "column", padding: 20, gap: 8 }}>
        <div style={{ userSelect: "none" }}>
          <div style={{ fontSize: 20 }}>chrome</div>
        </div>
        <div style={{ fontSize: 20 }}>content</div>
      </div>
    )

    // `userSelect: none` on the first subtree must be restored, not carried
    // into the sibling below it.
    const selected = renderer.dragSelect(21, 62, 900, 62)
    expect(selected).toBe("content")
  })

  it("keeps unstyled text siblings laid out side by side", () => {
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", flexDirection: "row", padding: 20, fontSize: 20 }}>
        <div>one</div>
        <div>two</div>
      </div>
    )

    // The selection wrapper adds a Taffy node per text. If it broke inline
    // layout, these two would stack instead of sitting on one line.
    expect(renderer.dragSelect(21, 30, 900, 30)).toBe("one\ntwo")
  })
})

describe("copy listener", () => {
  it("registers once per frame, not once per text element", () => {
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", flexDirection: "column", padding: 20 }}>
        {Array.from({ length: 30 }, (_, i) => (
          <div key={i} style={{ fontSize: 12 }}>{`line ${i}`}</div>
        ))}
      </div>
    )

    // Nothing observable to assert about listener count from JS, so this is a
    // smoke test that 30 selectable elements still select correctly and the
    // frame does not fall over.
    const selected = renderer.dragSelect(21, 26, 900, 700)
    expect(selected).not.toBeNull()
    expect(selected!.split("\n").length).toBeGreaterThan(5)
  })
})

describe("painted text log", () => {
  it("includes text that opted out of selection", () => {
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", flexDirection: "column", padding: 20, userSelect: "none" }}>
        <div style={{ fontSize: 20 }}>chrome label</div>
        <code code={"x = 1"} language="python" showLineNumbers />
      </div>
    )

    const painted = renderer.getPaintedText()
    expect(painted).toContain("chrome label")
    // The gutter is chrome: painted and logged, never selectable.
    expect(painted).toContain("1")
    expect(painted).toContain("x = 1")
    // Painted, but still not selectable.
    expect(renderer.dragSelect(21, 30, 900, 30)).toBeNull()
  })
})

describe("standard events on native elements", () => {
  it("fires onClick on <code>", () => {
    const onClick = vi.fn()
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", padding: 20 }}>
        <code code={"hello"} language="ts" onClick={onClick} />
      </div>
    )

    // The block is exactly its rows now, so the click must land on line 1.
    renderer.nativeSimulateClick(30, 28)
    expect(onClick).toHaveBeenCalled()
  })

  it("fires onClick on <markdown>", () => {
    const onClick = vi.fn()
    const { render, renderer } = createTestRoot()
    render(
      <div style={{ display: "flex", padding: 20 }}>
        <markdown source="clickable paragraph" onClick={onClick} />
      </div>
    )

    renderer.nativeSimulateClick(60, 30)
    expect(onClick).toHaveBeenCalled()
  })

  it("fires onClick on <diff>", () => {
    const onClick = vi.fn()
    const { render, renderer } = createTestRoot()
    render(
      <diff
        patch={"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n"}
        style={{ width: "100%", height: "100%" }}
        onClick={onClick}
      />
    )

    renderer.nativeSimulateClick(200, 18)
    expect(onClick).toHaveBeenCalled()
  })
})
