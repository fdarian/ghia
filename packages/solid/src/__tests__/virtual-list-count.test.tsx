/// A shrinking `itemCount` on a windowed `<virtual-list>` keeps the list state: nothing measured is
/// measured again and the scroll anchor stays (packages/react has the other cases).
import { createSignal, For } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const ROW = 36

describe.skipIf(!hasNativeTestRenderer)("Solid virtual-list itemCount", () => {
  it("drops the tail of the state on a shrink and measures nothing again", () => {
    const [count, setCount] = createSignal(10_000)
    const [start, setStart] = createSignal(0)
    const app = createTestRoot({ width: 400, height: 300 })
    app.renderer.setInlineDraws(false)
    app.render(() => (
      <virtual-list itemCount={count()} windowStart={start()} estimatedItemHeight={ROW} style={{ width: 400, height: 300 }}>
        <For each={Array.from({ length: 60 }, (_, offset) => start() + offset)}>
          {(index) => (
            <div style={{ height: ROW, flexShrink: 0 }}>
              <div>{`row-${index}`}</div>
            </div>
          )}
        </For>
      </virtual-list>
    ))
    const renderer = app.renderer
    renderer.drawFrame()
    const id = renderer.findByType("virtual-list")[0].id
    renderer.scrollToItem(id, 100)
    app.flushSync(() => setStart(90))
    renderer.drawFrame()
    expect(renderer.getListScrollTop(id)).toEqual([100, 0, 300])

    renderer.resetBuildCounters()
    const before = renderer.getLayoutCounters()
    app.flushSync(() => setCount(9_999))
    renderer.drawFrame()
    const after = renderer.getLayoutCounters()
    const built = renderer.getBuildCounters()

    expect(built.listStatesCreated).toBe(0)
    expect(built.listItemsSpliced).toBe(1)
    expect(after.measures - before.measures).toBe(0)
    expect(after.nodesCreated - before.nodesCreated).toBe(0)
    expect(renderer.getListScrollTop(id)).toEqual([100, 0, 300])
  })
})
