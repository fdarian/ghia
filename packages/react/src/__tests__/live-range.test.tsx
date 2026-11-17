/** A live `Range` over a React tree: the host config's placements, removals and text updates move it. */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("live Range in React", () => {
  let testRoot: ReturnType<typeof createTestRoot>

  /** Renders `tree(initial)`, and gives back a function that renders `tree(next)` over it. */
  function stateful<Value>(initial: Value, tree: (value: Value) => React.ReactNode): (next: Value) => void {
    testRoot.render(<>{tree(initial)}</>)
    return (next) => testRoot.render(<>{tree(next)}</>)
  }

  beforeEach(() => {
    testRoot = createTestRoot()
  })

  afterEach(() => {
    testRoot.unmount()
  })

  it("follows a keyed insert before its end and a removal before its start", () => {
    const setItems = stateful(["a", "b", "c"], (items) => (
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    ))
    const list = document.body!.firstElementChild!
    const range = new Range()
    range.setStart(list, 1)
    range.setEnd(list, 2)
    expect(range.toString()).toBe("b")

    setItems(["x", "a", "b", "c"])
    expect([range.startOffset, range.endOffset]).toEqual([2, 3])
    expect(range.toString()).toBe("b")

    setItems(["x", "b", "c"])
    expect([range.startOffset, range.endOffset]).toEqual([1, 2])
    expect(range.toString()).toBe("b")
  })

  it("moves a range that was inside a node React removed to the place it was", () => {
    const setShown = stateful(true, (shown) => (
      <div>
        <p>before</p>
        {shown ? <p>inside</p> : null}
        <p>after</p>
      </div>
    ))
    const box = document.body!.firstElementChild!
    const paragraph = box.children[1]
    const at = Array.from(box.childNodes).indexOf(paragraph)
    const inside = paragraph.firstChild!
    const range = new Range()
    range.setStart(inside, 1)
    range.setEnd(inside, 4)
    expect(range.toString()).toBe("nsi")

    setShown(false)
    expect(range.startContainer).toBe(box)
    expect([range.startOffset, range.endOffset]).toEqual([at, at])
    expect(range.collapsed).toBe(true)
  })

  it("collapses a range in a text node React updates, as an assignment to data does", () => {
    const setText = stateful("hello", (text) => <p>{text}</p>)
    const node = document.body!.firstElementChild!.firstChild!
    const range = new Range()
    range.setStart(node, 1)
    range.setEnd(node, 4)
    setText("world")
    expect(range.startContainer).toBe(node)
    expect([range.startOffset, range.endOffset]).toEqual([0, 0])
  })

  it("is moved by the same data and split writes from code on a mounted node", () => {
    stateful("hello", (text) => <p>{text}</p>)
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
