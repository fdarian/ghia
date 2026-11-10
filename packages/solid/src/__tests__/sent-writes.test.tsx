import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { describe, expect, it } from "vitest"
import { decodeWireBatchForTest } from "@ghia/native/testing"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

type Op = [string, ...unknown[]]

/** Every op that crossed into Rust, per `applyBatch` call. */
function recordBatches(renderer: { applyBatch(bytes: Uint8Array): unknown }) {
  const batches: Op[][] = []
  const original = renderer.applyBatch.bind(renderer)
  renderer.applyBatch = (bytes: Uint8Array) => {
    batches.push(decodeWireBatchForTest(bytes) as Op[])
    return original(bytes)
  }
  return {
    batches,
    ops: (name: string) => batches.flat().filter((op) => op[0] === name),
    count: () => batches.flat().length,
  }
}

describe.skipIf(!hasNativeTestRenderer)("writes the host has already made", () => {
  it("queues no setStyle when an effect runs again and builds an equal style", () => {
    const [label, setLabel] = createSignal("one")
    const app = createTestRoot()
    // The style reads the label, so each new label runs the effect and builds an equal style again.
    app.render(() => (
      <div
        aria-label={label()}
        style={{ width: label() === "never" ? 1 : 100, height: 40, hover: { backgroundColor: "#222" } }}
      />
    ))
    const sent = recordBatches(app.renderer)

    app.flushSync(() => setLabel("two"))
    app.flushSync(() => setLabel("three"))

    expect(sent.ops("setStyle")).toEqual([])
    expect(sent.ops("setCustomProp").map((op) => op[3])).toEqual(["two", "three"])
    expect(sent.count()).toBe(2)
    app.unmount()
  })

  it("queues the two rows that changed when every row of a list runs its effect again", () => {
    const [selected, setSelected] = createSignal(0)
    const app = createTestRoot()
    app.render(() => (
      <div>
        {Array.from({ length: 50 }, (_, index) => (
          <div
            style={{
              height: 20,
              borderBottom: "1px solid #eee",
              backgroundColor: selected() === index ? "#dbeafe" : undefined,
            }}
          >
            <div style={{ color: selected() === index ? "#000" : "#111" }}>row {index}</div>
          </div>
        ))}
      </div>
    ))
    const sent = recordBatches(app.renderer)

    app.flushSync(() => setSelected(7))

    // The row that was selected and the row that is now: a div and a text each.
    expect(sent.ops("setStyle").map((op) => op[1])).toHaveLength(4)
    expect(sent.count()).toBe(4)
    app.unmount()
  })

  it("queues a style that changed, and the empty style of one that was removed", () => {
    const [style, setStyle] = createSignal<{ width: number } | undefined>({ width: 100 })
    const app = createTestRoot()
    app.render(() => <div style={style()} />)
    const sent = recordBatches(app.renderer)

    app.flushSync(() => setStyle({ width: 120 }))
    app.flushSync(() => setStyle(undefined))
    app.flushSync(() => setStyle(undefined))

    expect(sent.ops("setStyle").map((op) => op[2])).toEqual([{ width: 120 }, {}])
    app.unmount()
  })

  it("queues a style object that was changed in place", () => {
    const [store, setStore] = createStore({ width: 100, height: 40 })
    const [label, setLabel] = createSignal("one")
    const app = createTestRoot()
    app.render(() => <div aria-label={label()} style={store} />)
    const sent = recordBatches(app.renderer)

    app.flushSync(() => setStore("width", 140))
    expect(sent.ops("setStyle").map((op) => op[2])).toEqual([{ width: 140, height: 40 }])

    app.flushSync(() => setLabel("two"))
    expect(sent.ops("setStyle")).toHaveLength(1)
    app.unmount()
  })

  it("writes a key order that differs, since the later of a shorthand and a longhand wins", () => {
    const [flip, setFlip] = createSignal(false)
    const app = createTestRoot()
    app.render(() => <div style={flip() ? { paddingLeft: 4, padding: 8 } : { padding: 8, paddingLeft: 4 }} />)
    const sent = recordBatches(app.renderer)

    app.flushSync(() => setFlip(true))

    expect(sent.ops("setStyle")).toHaveLength(1)
    app.unmount()
  })

  it("queues a custom prop only when its value changed", () => {
    const [tick, setTick] = createSignal(0)
    const app = createTestRoot()
    app.render(() => <div aria-label={`n${tick() % 2}`} highlight={{ query: "needle" }} style={{ width: 10 }} />)
    const sent = recordBatches(app.renderer)

    app.flushSync(() => setTick(2))
    expect(sent.count()).toBe(0)

    app.flushSync(() => setTick(1))
    expect(sent.ops("setCustomProp").map((op) => [op[2], op[3]])).toEqual([["aria-label", "n1"]])
    app.unmount()
  })
})
