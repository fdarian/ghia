/**
 * Libraries build and move DOM nodes from code, mixed with the nodes Solid made: `createElement`,
 * `appendChild`, `insertAdjacentElement`, `remove`, `textContent`. Native follows the tree the
 * code leaves, and `MutationObserver` hears it.
 */
import { createSignal, For } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { document, type MutationRenderer, type NativeRenderer } from "@ghia/native/host"
import { HostRoot } from "../host.js"
import { useGpuix } from "../root.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

type Handle = { nativeId: number }

describe.skipIf(!hasNativeTestRenderer)("DOM building from code in Solid", () => {
  let app: ReturnType<typeof createTestRoot>
  const observers: MutationObserver[] = []

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    app.unmount()
  })

  /** What the code's change leaves for native: the flush a microtask does. */
  async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    app.renderer.flush()
  }

  function nativeOf(node: Node): ReturnType<typeof app.renderer.getElement> {
    return app.renderer.getElement((node as unknown as Handle).nativeId)
  }

  function nativeChildren(node: Node): number[] {
    return nativeOf(node)!.children
  }

  function mountFramework(): HTMLElement {
    let box: HTMLElement | undefined
    app.render(() => (
      <div ref={(element) => (box = element as unknown as HTMLElement)} data-kind="framework" style={{ width: 30, height: 10 }}>
        framework
      </div>
    ))
    return box!
  }

  it("draws an element made by code once it is appended to body", async () => {
    mountFramework()
    const note = document.createElement("div")
    expect(note).toBeInstanceOf(HTMLElement)
    expect(note.tagName).toBe("DIV")
    expect((note as unknown as Handle).nativeId).toBe(0)
    note.textContent = "from code"
    expect(note.isConnected).toBe(false)
    expect(document.body!.appendChild(note)).toBe(note)
    expect(note.isConnected).toBe(true)
    await settle()
    expect(app.renderer.findByText("from code")).toBeDefined()
    expect(nativeOf(note)!.parentId).toBe((document.body as unknown as Handle).nativeId)
    expect(nativeChildren(document.body!)).toEqual([...document.body!.children].map((child) => (child as unknown as Handle).nativeId))
  })

  it("builds a subtree before inserting it, and inserts it under head and html", async () => {
    mountFramework()
    const outer = document.createElement("div")
    const inner = document.createElement("span")
    inner.appendChild(document.createTextNode("deep"))
    outer.appendChild(inner)
    expect(app.renderer.findByText("deep")).toBeUndefined()
    document.head!.appendChild(outer)
    await settle()
    expect(app.renderer.findByText("deep")).toBeDefined()
    expect(nativeOf(outer)!.parentId).toBe((document.head as unknown as Handle).nativeId)
    const extra = document.createElement("div")
    document.documentElement!.appendChild(extra)
    await settle()
    expect(nativeOf(extra)!.parentId).toBe((document.documentElement as unknown as Handle).nativeId)
  })

  it("createElementNS makes an svg element that is an SVGElement", () => {
    mountFramework()
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    expect(svg).toBeInstanceOf(SVGElement)
    expect(path.tagName).toBe("path")
    svg.appendChild(path)
    document.body!.appendChild(svg)
    expect(path.isConnected).toBe(true)
  })

  it("places an element next to a framework-owned one with insertAdjacentElement", async () => {
    const box = mountFramework()
    const after = document.createElement("div")
    const before = document.createElement("div")
    expect(box.insertAdjacentElement("afterend", after)).toBe(after)
    box.insertAdjacentElement("beforebegin", before)
    await settle()
    expect([...document.body!.children]).toEqual([before, box, after])
    expect(nativeChildren(document.body!)).toEqual(
      [before, box, after].map((element) => (element as unknown as Handle).nativeId)
    )
  })

  it("moves a framework-owned element with insertBefore as one native move, and the framework's next update works", async () => {
    const [items, setItems] = createSignal(["a", "b", "c"])
    let list: HTMLElement | undefined
    let mutations: NonNullable<ReturnType<typeof useGpuix>>["mutations"] | undefined
    app.render(() => {
      mutations = useGpuix()!.mutations
      return (
        <div ref={(element) => (list = element as unknown as HTMLElement)}>
          <For each={items()}>{(item) => <span data-item={item} />}</For>
        </div>
      )
    })
    const spans = [...list!.children]
    const created = vi.spyOn(mutations!, "createElement")
    const destroyed = vi.spyOn(mutations!, "destroyElement")
    list!.insertBefore(spans[2], spans[0])
    await settle()
    expect([...list!.children]).toEqual([spans[2], spans[0], spans[1]])
    expect(created).not.toHaveBeenCalled()
    expect(destroyed).not.toHaveBeenCalled()
    setItems(["a", "b", "c", "d"])
    await settle()
    const order = [...list!.children].map((child) => child.getAttribute("data-item"))
    // Where Solid puts "d" follows where code left its last node, as in a browser.
    expect([...order].sort()).toEqual(["a", "b", "c", "d"])
    expect(nativeChildren(list!)).toEqual([...list!.children].map((child) => (child as unknown as Handle).nativeId))
    setItems(["d", "c"])
    await settle()
    expect([...list!.children].map((child) => child.getAttribute("data-item")).sort()).toEqual(["c", "d"])
    expect(nativeChildren(list!)).toEqual([...list!.children].map((child) => (child as unknown as Handle).nativeId))
  })

  it("a <For> reorder after code moved one of its nodes keeps the tree, the mirror and native one", async () => {
    const [items, setItems] = createSignal(["a", "b", "c"])
    let list: HTMLElement | undefined
    app.render(() => (
      <div ref={(element) => (list = element as unknown as HTMLElement)}>
        <For each={items()}>{(item) => <span data-item={item} />}</For>
      </div>
    ))
    const byItem = new Map([...list!.children].map((child) => [child.getAttribute("data-item"), child]))
    list!.appendChild(byItem.get("a")!)
    await settle()
    const itemsNow = () => [...list!.children].map((child) => child.getAttribute("data-item")).sort()
    const consistent = () =>
      expect(nativeChildren(list!)).toEqual([...list!.children].map((child) => (child as unknown as Handle).nativeId))
    // Solid places by the siblings it knew, so the order after code reordered is the one a browser gives;
    // what must hold is that every node is there once and native has the order the mirror has.
    setItems(["c", "b", "a"])
    await settle()
    expect(itemsNow()).toEqual(["a", "b", "c"])
    consistent()
    setItems(["b", "a", "c", "d"])
    await settle()
    expect(itemsNow()).toEqual(["a", "b", "c", "d"])
    consistent()
    setItems(["d"])
    await settle()
    expect(itemsNow()).toEqual(["d"])
    consistent()
    for (const [item, node] of byItem) expect(item === "d" || !node.isConnected).toBe(true)
  })

  it("keeps a removed element's text, props and style through a flush, and draws it when it is inserted again", async () => {
    const box = mountFramework()
    const handle = (box as unknown as Handle).nativeId
    box.remove()
    expect(box.isConnected).toBe(false)
    expect(box.parentNode).toBeNull()
    expect(app.renderer.getElement(handle)).toBeDefined()
    await settle()
    expect(app.renderer.getElement(handle)).toBeUndefined()
    expect(app.renderer.findByText("framework")).toBeUndefined()
    expect(box.getAttribute("data-kind")).toBe("framework")
    expect(box.textContent?.trim()).toBe("framework")
    document.body!.appendChild(box)
    await settle()
    const native = nativeOf(box)!
    expect(app.renderer.findByText("framework")).toBeDefined()
    expect(native.style.width).toBeDefined()
    expect(box.isConnected).toBe(true)
  })

  it("keeps a removed element that is inserted again in the same turn, without making it again", async () => {
    const box = mountFramework()
    const handle = (box as unknown as Handle).nativeId
    box.remove()
    document.body!.appendChild(box)
    await settle()
    expect(app.renderer.getElement(handle)).toBeDefined()
    expect(app.renderer.findByText("framework")).toBeDefined()
  })

  it("keeps listeners of an element code removed and inserted after the flush", async () => {
    const box = mountFramework()
    const listener = vi.fn()
    box.addEventListener("click", listener)
    box.remove()
    await settle()
    document.body!.appendChild(box)
    await settle()
    box.click()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("lets code put an element into a removed subtree and take the subtree back", async () => {
    const box = mountFramework()
    const outer = document.createElement("div")
    outer.appendChild(box)
    await settle()
    expect(app.renderer.getElement((box as unknown as Handle).nativeId)).toBeUndefined()
    expect(box.isConnected).toBe(false)
    document.body!.appendChild(outer)
    await settle()
    expect(app.renderer.findByText("framework")).toBeDefined()
    expect(nativeOf(box)!.parentId).toBe((outer as unknown as Handle).nativeId)
  })

  it("textContent replaces what a framework element holds, natively too", async () => {
    const box = mountFramework()
    box.textContent = "replaced"
    await settle()
    expect(app.renderer.findByText("framework")).toBeUndefined()
    expect(app.renderer.findByText("replaced")).toBeDefined()
    box.textContent = ""
    await settle()
    expect(app.renderer.findByText("replaced")).toBeUndefined()
    expect(box.childNodes).toHaveLength(0)
  })

  it("a text node's data changes what is drawn", async () => {
    const box = mountFramework()
    const text = document.createTextNode("one")
    box.textContent = ""
    box.appendChild(text)
    await settle()
    expect(app.renderer.findByText("one")).toBeDefined()
    text.data = "two"
    await settle()
    expect(app.renderer.findByText("one")).toBeUndefined()
    expect(app.renderer.findByText("two")).toBeDefined()
  })

  it("replaceWith and replaceChildren swap framework nodes for made ones", async () => {
    const box = mountFramework()
    const made = document.createElement("div")
    made.textContent = "made"
    box.replaceWith(made)
    await settle()
    expect([...document.body!.children]).toEqual([made])
    expect(app.renderer.findByText("framework")).toBeUndefined()
    expect(app.renderer.findByText("made")).toBeDefined()
    made.replaceChildren("a", document.createElement("span"), "b")
    expect(made.childNodes).toHaveLength(3)
    await settle()
    expect(nativeChildren(made)).toHaveLength(3)
  })

  it("throws the DOM's errors for a bad tree change, and leaves the tree alone", async () => {
    const box = mountFramework()
    const inner = document.createElement("div")
    box.appendChild(inner)
    expect(() => inner.appendChild(box)).toThrow(expect.objectContaining({ name: "HierarchyRequestError" }))
    expect(() => document.body!.insertBefore(inner, inner.firstChild ?? document.createElement("span"))).toThrow(
      expect.objectContaining({ name: "NotFoundError" })
    )
    expect(() => document.createElement("marquee")).toThrow(expect.objectContaining({ name: "NotSupportedError" }))
    expect(inner.parentNode).toBe(box)
    await settle()
  })

  it("refuses to move a node into another window's tree", () => {
    const box = mountFramework()
    const quiet = new Proxy({}, { get: () => () => {} }) as MutationRenderer
    let nextId = 1000
    const otherWindow = new HostRoot({
      mutations: quiet,
      nativeRenderer: {} as NativeRenderer,
      eventHandlers: new Map(),
      allocateId: () => ++nextId,
    })
    expect(() => (otherWindow.body as unknown as Node).appendChild(box)).toThrow(
      expect.objectContaining({ name: "HierarchyRequestError" })
    )
    expect(box.parentNode).toBe(document.body)
  })

  it("refuses a detached parent that holds a node of another window before it changes anything", () => {
    const box = mountFramework()
    const creates: unknown[] = []
    const recording = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => { if (name === "createElement") creates.push(args) } }) as MutationRenderer
    let nextId = 1000
    const otherWindow = new HostRoot({
      mutations: recording,
      nativeRenderer: {} as NativeRenderer,
      eventHandlers: new Map(),
      allocateId: () => ++nextId,
    })
    creates.length = 0
    const holder = document.createElement("div")
    const sibling = document.createElement("span")
    holder.append(sibling, box)
    expect(() => (otherWindow.body as unknown as Node).appendChild(holder)).toThrow(
      expect.objectContaining({ name: "HierarchyRequestError" })
    )
    expect(holder.parentNode).toBeNull()
    expect(creates).toEqual([])
    expect([...holder.childNodes]).toEqual([sibling, box])
  })

  it("refuses a node of another window in a parent that code removed this turn and native still holds", () => {
    const box = mountFramework()
    const quiet = new Proxy({}, { get: () => () => {} }) as MutationRenderer
    let nextId = 1000
    const otherWindow = new HostRoot({
      mutations: quiet,
      nativeRenderer: {} as NativeRenderer,
      eventHandlers: new Map(),
      allocateId: () => ++nextId,
    })
    const holder = document.createElement("div")
    box.appendChild(holder)
    holder.remove()
    expect(() => holder.appendChild(otherWindow.body as unknown as Node)).toThrow(
      expect.objectContaining({ name: "HierarchyRequestError" })
    )
    expect(holder.childNodes).toHaveLength(0)
  })

  it("tells a MutationObserver what code does, moves as a removal and an insertion", async () => {
    const box = mountFramework()
    const observer = new MutationObserver(() => {})
    observer.observe(document.body!, { childList: true, subtree: true, characterData: true })
    observers.push(observer)
    const made = document.createElement("div")
    document.body!.appendChild(made)
    let records = observer.takeRecords()
    expect(records).toHaveLength(1)
    expect(records[0].addedNodes).toEqual([made])
    expect(records[0].previousSibling).toBe(box)
    document.body!.insertBefore(made, box)
    records = observer.takeRecords()
    expect(records.map((record) => [record.addedNodes.length, record.removedNodes.length])).toEqual([[0, 1], [1, 0]])
    made.textContent = "t"
    records = observer.takeRecords()
    expect(records).toHaveLength(1)
    expect(records[0].target).toBe(made)
    const text = made.firstChild as Text
    text.data = "u"
    records = observer.takeRecords()
    expect(records).toHaveLength(1)
    expect(records[0].type).toBe("characterData")
    made.remove()
    records = observer.takeRecords()
    expect(records[0].removedNodes).toEqual([made])
    await settle()
  })
})
