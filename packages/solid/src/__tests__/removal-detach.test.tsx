import { Show, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { insertHostNode, removeHostNode } from "../host.js"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const rows = (count: number) =>
  Array.from({ length: count }, (_, row) => <div style={{ height: 50, flexShrink: 0 }}>{row}</div>)

describe.skipIf(!hasNativeTestRenderer)("Solid removal takes a node out of the tree at once", () => {
  it("reads layout without the subtree a keyed Show swapped out", () => {
    const view = (key: () => number, ref: (element: HostElement) => void) => () => (
      <div style={{ width: 300, height: 400, display: "flex", flexDirection: "column" }}>
        <Show when={key()} keyed>
          {(current) => (
            <div
              ref={ref}
              testId={`detail-${current}`}
              style={{ width: 300, height: 100, overflow: "scroll", flexShrink: 0 }}
            >
              {rows(current === 1 ? 4 : 10)}
            </div>
          )}
        </Show>
      </div>
    )
    const work = (renderer: TestRenderer, run: () => void) => {
      renderer.resetBuildCounters()
      const before = renderer.getLayoutCounters()
      run()
      const after = renderer.getLayoutCounters()
      return {
        built: renderer.getBuildCounters().elementsBuilt,
        created: after.nodesCreated - before.nodesCreated,
      }
    }

    // What laying out the new content costs on a page that never had the old one.
    const fresh = createTestRoot()
    let freshDetail!: HostElement
    const mounted = work(fresh.renderer, () => {
      fresh.render(view(() => 2, (element) => (freshDetail = element)))
      expect(freshDetail.scrollHeight).toBe(500)
    })

    const [key, setKey] = createSignal(1)
    let detail!: HostElement
    const app = createTestRoot()
    app.render(view(key, (element) => (detail = element)))
    expect(app.renderer.findByTestId("detail-1")).toBeDefined()
    expect(detail.scrollHeight).toBe(200)

    const swapped = work(app.renderer, () => {
      setKey(2)
      expect(detail.scrollHeight).toBe(500)
    })

    // The old scroller is out of the tree natively, though nothing destroyed it yet.
    expect(app.renderer.findByTestId("detail-1")).toBeUndefined()
    expect(app.renderer.findByTestId("detail-2")).toBeDefined()
    expect(swapped.created).toBeLessThanOrEqual(mounted.created)
    expect(swapped.built).toBeLessThanOrEqual(mounted.built)
  })

  it("leaves a scroller with the children of the new content only", () => {
    const [key, setKey] = createSignal(1)
    let scroller!: HostElement
    const app = createTestRoot()
    app.render(() => (
      <div ref={scroller} style={{ width: 300, height: 100, overflow: "scroll" }}>
        <Show when={key()} keyed>
          {(current) => <div style={{ height: current === 1 ? 700 : 200, flexShrink: 0 }} />}
        </Show>
      </div>
    ))
    expect(scroller.scrollHeight).toBe(700)
    setKey(2)
    // The DOM answers with the new child only: the old one is out of the document.
    expect(scroller.scrollHeight).toBe(200)
    expect(app.renderer.getElement(scroller.id)!.children).toHaveLength(1)
  })

  it("keeps the element and its focus when a node is removed and inserted again in one batch", () => {
    let parent!: HostElement
    let field!: HostElement
    const app = createTestRoot()
    app.render(() => (
      <div ref={parent} style={{ width: 300, height: 200 }}>
        <input ref={field} testId="field" defaultValue="x" style={{ width: 100, height: 20 }} />
        <div style={{ width: 100, height: 20 }} />
      </div>
    ))
    const id = field.id
    app.renderer.focusElement(id)
    expect(app.renderer.getFocusedElementId()).toBe(id)

    removeHostNode(parent, field)
    insertHostNode(parent, field, null)
    app.root.flush()

    expect(field.id).toBe(id)
    expect(field.mounted).toBe(true)
    expect(app.renderer.getFocusedElementId()).toBe(id)
    expect(app.renderer.findByTestId("field")?.id).toBe(id)
  })

  it("keeps the element, its focus and its scroll offset when a read comes between the removal and the insertion", () => {
    let parent!: HostElement
    let other!: HostElement
    let scroller!: HostElement
    let field!: HostElement
    const app = createTestRoot()
    app.render(() => (
      <div ref={parent} style={{ width: 300, height: 400 }}>
        <div ref={scroller} style={{ width: 200, height: 100, overflow: "scroll", flexShrink: 0 }}>
          <input ref={field} testId="field" defaultValue="x" style={{ width: 100, height: 20, flexShrink: 0 }} />
          <div style={{ height: 400, flexShrink: 0 }} />
        </div>
        <div ref={other} style={{ width: 100, height: 100 }} />
      </div>
    ))
    scroller.scrollTop = 120
    const id = scroller.id
    const fieldId = field.id
    app.renderer.focusElement(fieldId)

    removeHostNode(parent, scroller)
    // A forced layout read: the node is out of the tree, still alive.
    expect(other.getBoundingClientRect().y).toBe(0)
    expect(app.renderer.findByTestId("field")).toBeUndefined()
    expect(scroller.mounted).toBe(true)

    insertHostNode(parent, scroller, other)
    app.root.flush()

    expect(scroller.id).toBe(id)
    expect(field.id).toBe(fieldId)
    expect(app.renderer.getFocusedElementId()).toBe(fieldId)
    expect(scroller.scrollTop).toBe(120)
    expect(other.getBoundingClientRect().y).toBe(100)
  })

  it("moves a node under another parent after a read", () => {
    let from!: HostElement
    let to!: HostElement
    let moved!: HostElement
    const app = createTestRoot()
    app.render(() => (
      <div style={{ width: 300, height: 300 }}>
        <div ref={from} style={{ width: 100 }}>
          <div ref={moved} testId="moved" style={{ width: 50, height: 50 }} />
        </div>
        <div ref={to} style={{ width: 100 }} />
      </div>
    ))
    const id = moved.id
    expect(from.getBoundingClientRect().height).toBe(50)
    removeHostNode(from, moved)
    // Auto height: the box of `from` is what is left in it.
    expect(from.getBoundingClientRect().height).toBe(0)
    expect(app.renderer.getElement(from.id)!.children).not.toContain(id)
    insertHostNode(to, moved, null)
    app.root.flush()
    expect(moved.id).toBe(id)
    expect(to.getBoundingClientRect().height).toBe(50)
    expect(app.renderer.getElement(to.id)!.children).toContain(id)
    expect(app.renderer.getElement(from.id)!.children).not.toContain(id)
  })

  it("destroys a removed node that stayed out at the flush", async () => {
    const [shown, setShown] = createSignal(true)
    const app = createTestRoot()
    app.render(() => (
      <div>
        <Show when={shown()}>
          <div testId="panel" style={{ width: 50, height: 50 }}>
            <div>panel</div>
          </div>
        </Show>
      </div>
    ))
    const before = app.renderer.getRetainedElementCount()
    setTimeout(() => setShown(false), 0)
    await tick()
    await tick()
    expect(app.renderer.getRetainedElementCount()).toBeLessThan(before)
    expect(app.renderer.findByTestId("panel")).toBeUndefined()
  })

  it("destroys a node that stayed out after a read flushed its detach", () => {
    let parent!: HostElement
    let gone!: HostElement
    const app = createTestRoot()
    app.render(() => (
      <div ref={parent} style={{ width: 100 }}>
        <div ref={gone} style={{ width: 50, height: 50 }} />
      </div>
    ))
    const before = app.renderer.getRetainedElementCount()
    expect(parent.getBoundingClientRect().height).toBe(50)
    removeHostNode(parent, gone)
    // Auto height: the read measures a parent that no longer holds the node.
    expect(parent.getBoundingClientRect().height).toBe(0)
    // The read applied the detach; the element is alive until the flush destroys it.
    expect(app.renderer.getRetainedElementCount()).toBe(before)
    app.root.flush()
    expect(app.renderer.getRetainedElementCount()).toBe(before - 1)
    app.unmount()
    expect(app.renderer.getRetainedElementCount()).toBe(0)
  })
})
