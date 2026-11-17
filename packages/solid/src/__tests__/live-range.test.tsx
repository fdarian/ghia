/** A live `Range` over a Solid tree: the host's inserts, removals and text updates move it. */
import { createSignal, For, Show } from "solid-js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("live Range in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    app.unmount()
  })

  it("follows a keyed insert before its end and a removal before its start", () => {
    const [items, setItems] = createSignal(["a", "b", "c"])
    app.render(() => (
      <ul>
        <For each={items()}>{(item) => <li>{item}</li>}</For>
      </ul>
    ))
    const list = document.body!.firstElementChild!
    const range = new Range()
    range.setStart(list, 1)
    range.setEnd(list, 2)
    expect(range.toString()).toBe("b")

    setItems(["x", "a", "b", "c"])
    expect(range.toString()).toBe("b")
    expect([range.startOffset, range.endOffset]).toEqual([2, 3])

    setItems(["x", "b", "c"])
    expect(range.toString()).toBe("b")
    expect([range.startOffset, range.endOffset]).toEqual([1, 2])
  })

  it("moves a range that was inside a node Solid removed to the place it was", () => {
    const [shown, setShown] = createSignal(true)
    app.render(() => (
      <div>
        <p>before</p>
        <Show when={shown()}>
          <p>inside</p>
        </Show>
        <p>after</p>
      </div>
    ))
    const box = document.body!.firstElementChild!
    const paragraph = box.children[1]
    const before = box.children[0]
    const after = box.children[2]
    const inside = paragraph.firstChild!
    const range = new Range()
    range.setStart(inside, 1)
    range.setEnd(inside, 4)
    expect(range.toString()).toBe("nsi")

    setShown(false)
    expect(range.startContainer).toBe(box)
    // Solid puts a placeholder where the node was before it takes the node out, so the range sits after the placeholder.
    const nodes = Array.from(box.childNodes)
    expect(range.collapsed).toBe(true)
    expect(range.startOffset).toBeGreaterThan(nodes.indexOf(before))
    expect(range.startOffset).toBeLessThanOrEqual(nodes.indexOf(after))
  })

  it("collapses a range in a text node Solid updates, as an assignment to data does", () => {
    const [text, setText] = createSignal("hello")
    app.render(() => <p>{text()}</p>)
    const node = document.body!.firstElementChild!.firstChild!
    const range = new Range()
    range.setStart(node, 1)
    range.setEnd(node, 4)
    setText("world")
    expect(range.startContainer).toBe(node)
    expect([range.startOffset, range.endOffset]).toEqual([0, 0])
  })

  it("is moved by the same data and split writes from code on a mounted node", () => {
    app.render(() => <p>hello</p>)
    const paragraph = document.body!.firstElementChild!
    const node = paragraph.firstChild as Text
    const range = new Range()
    range.setStart(node, 1)
    range.setEnd(node, 4)
    const rest = node.splitText(2)
    expect(range.endContainer).toBe(rest)
    expect(range.endOffset).toBe(2)
    expect(paragraph.childNodes).toHaveLength(2)
    expect(range.toString()).toBe("ell")
    node.deleteData(0, 1)
    expect(range.startOffset).toBe(0)
    expect(range.toString()).toBe("ell")
  })
})
