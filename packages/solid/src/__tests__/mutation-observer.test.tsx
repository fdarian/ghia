/** `MutationObserver` over a Solid tree: the host's inserts, removals, props and text feed the queue. */
import { createSignal, For, Show } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { document, hasMutationObservers } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("MutationObserver in Solid", () => {
  let app: ReturnType<typeof createTestRoot>
  const observers: MutationObserver[] = []

  function observe(target: Node, options: MutationObserverInit): MutationObserver {
    const observer = new MutationObserver(() => {})
    observer.observe(target, options)
    observers.push(observer)
    return observer
  }

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    app.unmount()
  })

  it("sees nodes the app adds to and removes from body, with subtree", () => {
    const [shown, setShown] = createSignal(false)
    app.render(() => <Show when={shown()}><div><span /></div></Show>)
    const observer = observe(document.body!, { childList: true, subtree: true })
    setShown(true)
    const added = observer.takeRecords()
    const top = document.body!.firstElementChild!
    const placed = added.find((record) => record.target === document.body)
    expect(placed!.addedNodes).toEqual([top])
    setShown(false)
    const removed = observer.takeRecords()
    expect(removed).toHaveLength(1)
    expect(removed[0].target).toBe(document.body)
    expect(removed[0].removedNodes[0]).toBe(top)
    expect(removed[0].previousSibling).toBeNull()
    expect(removed[0].nextSibling).toBeNull()
  })

  it("reports a keyed list's inserts with their siblings", () => {
    const [items, setItems] = createSignal(["a"])
    let list: HTMLElement | undefined
    app.render(() => (
      <div ref={(element) => (list = element as unknown as HTMLElement)}>
        <For each={items()}>{(item) => <span data-item={item} />}</For>
      </div>
    ))
    const observer = observe(list!, { childList: true })
    setItems(["a", "b"])
    const records = observer.takeRecords()
    expect(records).toHaveLength(1)
    expect(records[0].addedNodes).toHaveLength(1)
    expect((records[0].addedNodes[0] as Element).getAttribute("data-item")).toBe("b")
    expect(records[0].previousSibling).toBe(list!.firstElementChild)
    expect(records[0].nextSibling).toBeNull()
  })

  it("reports an attribute change with oldValue and honours attributeFilter", () => {
    const [value, setValue] = createSignal("1")
    const [other, setOther] = createSignal("1")
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} data-a={value()} data-b={other()} />)
    const all = observe(box!, { attributes: true, attributeOldValue: true })
    const filtered = observe(box!, { attributeFilter: ["data-b"] })
    setValue("2")
    setOther("2")
    expect(all.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["data-a", "1"],
      ["data-b", "1"],
    ])
    expect(filtered.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([["data-b", null]])
  })

  it("makes a record for a style change, none for a handler or an unchanged value", () => {
    const [color, setColor] = createSignal("red")
    const [handler, setHandler] = createSignal(() => {})
    let box: HTMLElement | undefined
    app.render(() => (
      <div ref={(element) => (box = element as unknown as HTMLElement)} data-a="1" style={{ background: color() }} onClick={handler()} />
    ))
    const observer = observe(box!, { attributes: true, attributeOldValue: true })
    setColor("blue")
    setHandler(() => () => {})
    expect(observer.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["style", "background: red;"],
    ])
    setColor("blue")
    expect(observer.takeRecords()).toHaveLength(0)
  })

  it("records a style change as a style attribute with the old cssText", () => {
    const [color, setColor] = createSignal("red")
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} style={{ background: color() }} />)
    const observer = observe(box!, { attributes: true, attributeOldValue: true })
    setColor("blue")
    expect(observer.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["style", "background: red;"],
    ])
  })

  it("reports a text change as characterData with the old text", () => {
    const [text, setText] = createSignal("one")
    app.render(() => <div>{text()}</div>)
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
    const [value, setValue] = createSignal(0)
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} data-n={value()} />)
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
    const [value, setValue] = createSignal("1")
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} data-a={value()} />)
    expect(hasMutationObservers()).toBe(false)
    const binding = vi.spyOn(box as HTMLElement & Record<symbol, () => unknown>, Symbol.for("@ghia/native/dom-binding") as never)
    setValue("2")
    expect(binding).not.toHaveBeenCalled()
    expect(hasMutationObservers()).toBe(false)
  })
})
