/** `MutationObserver` over a React tree: the host config's placements, props and text feed the queue. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { document, hasMutationObservers } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("MutationObserver in React", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  const observers: MutationObserver[] = []

  function observe(target: Node, options: MutationObserverInit): MutationObserver {
    const observer = new MutationObserver(() => {})
    observer.observe(target, options)
    observers.push(observer)
    return observer
  }

  /** Renders `tree(initial)`, and gives back a function that renders `tree(next)` over it. */
  function stateful<Value>(initial: Value, tree: (value: Value) => React.ReactNode): (next: Value) => void {
    testRoot.render(<>{tree(initial)}</>)
    return (next) => testRoot.render(<>{tree(next)}</>)
  }

  beforeEach(() => {
    testRoot = createTestRoot()
  })

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    testRoot.unmount()
  })

  it("sees nodes the app adds to and removes from body, with subtree", () => {
    const setShown = stateful(false, (shown) => (shown ? <div><span /></div> : null))
    const observer = observe(document.body!, { childList: true, subtree: true })
    setShown(true)
    const top = document.body!.firstElementChild!
    const added = observer.takeRecords().filter((record) => record.target === document.body)
    expect(added).toHaveLength(1)
    expect(added[0].addedNodes).toEqual([top])
    setShown(false)
    const removed = observer.takeRecords()
    expect(removed).toHaveLength(1)
    expect(removed[0].target).toBe(document.body)
    expect(removed[0].removedNodes).toEqual([top])
    expect(removed[0].previousSibling).toBeNull()
    expect(removed[0].nextSibling).toBeNull()
  })

  it("reports a placement before a sibling, with both siblings", () => {
    let list: PublicInstance | null = null
    const setItems = stateful(["a", "c"], (items) => (
      <div ref={(instance) => (list = instance)}>
        {items.map((item) => (
          <span key={item} data-item={item} />
        ))}
      </div>
    ))
    const observer = observe(list!, { childList: true })
    setItems(["a", "b", "c"])
    const records = observer.takeRecords()
    expect(records).toHaveLength(1)
    expect((records[0].addedNodes[0] as Element).getAttribute("data-item")).toBe("b")
    expect((records[0].previousSibling as Element).getAttribute("data-item")).toBe("a")
    expect((records[0].nextSibling as Element).getAttribute("data-item")).toBe("c")
  })

  it("reports a move as a removal and an insertion", () => {
    let list: PublicInstance | null = null
    const setItems = stateful(["a", "b"], (items) => (
      <div ref={(instance) => (list = instance)}>
        {items.map((item) => (
          <span key={item} data-item={item} />
        ))}
      </div>
    ))
    const observer = observe(list!, { childList: true })
    setItems(["b", "a"])
    const records = observer.takeRecords()
    expect(records.map((record) => [record.addedNodes.length, record.removedNodes.length])).toEqual([
      [0, 1],
      [1, 0],
    ])
  })

  it("reports an attribute change with oldValue and honours attributeFilter", () => {
    let box: PublicInstance | null = null
    const setValue = stateful(["1", "1"] as const, (values) => (
      <div ref={(instance) => (box = instance)} data-a={values[0]} data-b={values[1]} />
    ))
    const all = observe(box!, { attributes: true, attributeOldValue: true })
    const filtered = observe(box!, { attributeFilter: ["data-b"] })
    setValue(["2", "2"])
    expect(all.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["data-a", "1"],
      ["data-b", "1"],
    ])
    expect(filtered.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([["data-b", null]])
  })

  it("makes no record for a style, a handler, children or an unchanged value", () => {
    let box: PublicInstance | null = null
    const setColor = stateful("red", (color) => (
      <div ref={(instance) => (box = instance)} data-a="1" style={{ background: color }} onClick={() => {}}>
        {color}
      </div>
    ))
    const observer = observe(box!, { attributes: true })
    setColor("blue")
    expect(observer.takeRecords()).toHaveLength(0)
  })

  it("reports a text change as characterData with the old text", () => {
    const setText = stateful("one", (text) => <text>{text}</text>)
    const node = document.body!.firstElementChild!.firstChild!
    const observer = observe(node, { characterData: true, characterDataOldValue: true })
    setText("two")
    const records = observer.takeRecords()
    expect(records).toHaveLength(1)
    expect(records[0].type).toBe("characterData")
    expect(records[0].target).toBe(node)
    expect(records[0].oldValue).toBe("one")
  })

  it("delivers in one microtask, and takeRecords and disconnect keep it from delivering", async () => {
    let box: PublicInstance | null = null
    const setValue = stateful(0, (value) => <div ref={(instance) => (box = instance)} data-n={value} />)
    const callback = vi.fn()
    const observer = new MutationObserver(callback)
    observers.push(observer)
    observer.observe(box!, { attributes: true })
    setValue(1)
    setValue(2)
    expect(callback).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0]).toHaveLength(2)

    setValue(3)
    expect(observer.takeRecords()).toHaveLength(1)
    setValue(4)
    observer.disconnect()
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it("costs nothing while no observer exists", () => {
    let box: PublicInstance | null = null
    const setValue = stateful("1", (value) => <div ref={(instance) => (box = instance)} data-a={value} />)
    expect(hasMutationObservers()).toBe(false)
    const binding = vi.spyOn(box as unknown as Record<symbol, () => unknown>, Symbol.for("@ghia/native/dom-binding"))
    setValue("2")
    expect(binding).not.toHaveBeenCalled()
    expect(hasMutationObservers()).toBe(false)
  })
})
