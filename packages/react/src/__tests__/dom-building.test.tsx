/**
 * Libraries build and move DOM nodes from code, mixed with the nodes React made: `createElement`,
 * `appendChild`, `insertAdjacentElement`, `remove`, `textContent`. Native follows the tree the
 * code leaves, and `MutationObserver` hears it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { document } from "@ghia/native/host"
import { useGpuix } from "../hooks/use-gpuix.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { hostConfig } from "../reconciler/host-config.js"
import { createPortal } from "../reconciler/portal.js"
import type { Container, PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Handle = { nativeId: number }

describeNative("DOM building from code in React", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  const observers: MutationObserver[] = []

  beforeEach(() => {
    testRoot = createTestRoot()
  })

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    testRoot.unmount()
  })

  /** What the code's change leaves for native: the flush a microtask does. */
  async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    testRoot.renderer.flush()
  }

  function nativeOf(node: Node): ReturnType<typeof testRoot.renderer.getElement> {
    return testRoot.renderer.getElement((node as unknown as Handle).nativeId)
  }

  function nativeChildren(node: Node): number[] {
    return nativeOf(node)!.children
  }

  function idsOf(nodes: Iterable<Node>): number[] {
    return [...nodes].map((node) => (node as unknown as Handle).nativeId)
  }

  function mountFramework(): HTMLElement {
    let box: PublicInstance | null = null
    testRoot.render(
      <div ref={(instance) => (box = instance)} data-kind="framework" style={{ width: 30, height: 10 }}>
        framework
      </div>
    )
    return box as unknown as HTMLElement
  }

  it("draws an element made by code once it is appended to body", async () => {
    mountFramework()
    const note = document.createElement("div")
    expect(note).toBeInstanceOf(HTMLElement)
    expect(note.tagName).toBe("DIV")
    note.textContent = "from code"
    expect(note.isConnected).toBe(false)
    expect(document.body!.appendChild(note)).toBe(note)
    expect(note.isConnected).toBe(true)
    await settle()
    expect(testRoot.renderer.findByText("from code")).toBeDefined()
    expect(nativeOf(note)!.parentId).toBe((document.body as unknown as Handle).nativeId)
    expect(nativeChildren(document.body!)).toEqual(idsOf(document.body!.children))
  })

  it("builds a subtree before inserting it, and inserts it under head and html", async () => {
    mountFramework()
    const outer = document.createElement("div")
    const inner = document.createElement("span")
    inner.appendChild(document.createTextNode("deep"))
    outer.appendChild(inner)
    expect(testRoot.renderer.findByText("deep")).toBeUndefined()
    document.head!.appendChild(outer)
    await settle()
    expect(testRoot.renderer.findByText("deep")).toBeDefined()
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
    expect(nativeChildren(document.body!)).toEqual(idsOf([before, box, after]))
  })

  it("moves a framework-owned element with insertBefore as one native move, and the framework's next render works", async () => {
    let list: PublicInstance | null = null
    let mutations: ReturnType<typeof useGpuix>["mutations"] | undefined
    function Probe() {
      mutations = useGpuix().mutations
      return null
    }
    const tree = (items: string[]) => (
      <>
        <Probe />
        <div ref={(instance) => (list = instance)}>
          {items.map((item) => (
            <span key={item} data-item={item} />
          ))}
        </div>
      </>
    )
    testRoot.render(tree(["a", "b", "c"]))
    const element = list as unknown as HTMLElement
    const spans = [...element.children]
    const created = vi.spyOn(mutations!, "createElement")
    const destroyed = vi.spyOn(mutations!, "destroyElement")
    element.insertBefore(spans[2], spans[0])
    await settle()
    expect([...element.children]).toEqual([spans[2], spans[0], spans[1]])
    expect(created).not.toHaveBeenCalled()
    expect(destroyed).not.toHaveBeenCalled()
    testRoot.render(tree(["a", "b", "c", "d"]))
    await settle()
    const order = [...element.children].map((child) => child.getAttribute("data-item"))
    expect(order).toHaveLength(4)
    expect(order.at(-1)).toBe("d")
    expect(nativeChildren(element)).toEqual(idsOf(element.children))
    testRoot.render(tree(["d", "b", "a"]))
    await settle()
    expect([...element.children].map((child) => child.getAttribute("data-item")).sort()).toEqual(["a", "b", "d"])
    expect(nativeChildren(element)).toEqual(idsOf(element.children))
  })

  it("keeps a removed element's text, props and style through a flush, and draws it when it is inserted again", async () => {
    const box = mountFramework()
    const handle = (box as unknown as Handle).nativeId
    box.remove()
    expect(box.isConnected).toBe(false)
    expect(box.parentNode).toBeNull()
    expect(testRoot.renderer.getElement(handle)).toBeDefined()
    await settle()
    expect(testRoot.renderer.getElement(handle)).toBeUndefined()
    expect(testRoot.renderer.findByText("framework")).toBeUndefined()
    expect(box.getAttribute("data-kind")).toBe("framework")
    expect(box.textContent?.trim()).toBe("framework")
    document.body!.appendChild(box)
    await settle()
    expect(testRoot.renderer.findByText("framework")).toBeDefined()
    expect(nativeOf(box)!.style.width).toBeDefined()
    expect(box.isConnected).toBe(true)
  })

  it("keeps a removed element that is inserted again in the same turn", async () => {
    const box = mountFramework()
    const handle = (box as unknown as Handle).nativeId
    box.remove()
    document.body!.appendChild(box)
    await settle()
    expect(testRoot.renderer.getElement(handle)).toBeDefined()
    expect(testRoot.renderer.findByText("framework")).toBeDefined()
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

  it("does not call a handler React removed while code had the element out of the document", async () => {
    let box: PublicInstance | null = null
    const fire = vi.fn()
    const tree = (armed: boolean) => (
      <div ref={(instance) => (box = instance)} onClick={armed ? fire : undefined} style={{ width: 30, height: 10 }} />
    )
    testRoot.render(tree(true))
    const element = box as unknown as HTMLElement
    element.remove()
    await settle()
    testRoot.render(tree(false))
    document.body!.appendChild(element)
    await settle()
    element.click()
    expect(fire).not.toHaveBeenCalled()
  })

  it("only links what React places in an element code removed and native released", async () => {
    let box: PublicInstance | null = null
    let mutations: ReturnType<typeof useGpuix>["mutations"] | undefined
    function Probe() {
      mutations = useGpuix().mutations
      return null
    }
    const tree = (withChild: boolean) => (
      <div ref={(instance) => (box = instance)} style={{ width: 30, height: 10 }}>
        <Probe />
        {withChild ? <span>late</span> : null}
      </div>
    )
    testRoot.render(tree(false))
    const element = box as unknown as HTMLElement
    element.remove()
    await settle()
    const created = vi.spyOn(mutations!, "createElement")
    testRoot.render(tree(true))
    await settle()
    expect(element.firstElementChild?.textContent).toBe("late")
    expect(created, "no native element for the released parent or its new child").not.toHaveBeenCalled()
    document.body!.appendChild(element)
    await settle()
    expect(testRoot.renderer.findByText("late")).toBeDefined()
  })

  it("only links what React places in a portal target code removed and native released", async () => {
    let layer: PublicInstance | null = null
    let mutations: ReturnType<typeof useGpuix>["mutations"] | undefined
    function Probe() {
      mutations = useGpuix().mutations
      return null
    }
    const tree = (items: string[]) => (
      <div>
        <Probe />
        <div ref={(instance) => (layer = instance ?? layer)} style={{ width: 30, height: 10 }} />
        {items.length > 0 && layer !== null
          ? createPortal(items.map((item) => <span key={item}>{item}</span>), layer)
          : null}
      </div>
    )
    testRoot.render(tree([]))
    const element = layer as unknown as HTMLElement
    element.remove()
    await settle()
    const created = vi.spyOn(mutations!, "createElement")
    testRoot.render(tree(["b"]))
    testRoot.render(tree(["a", "b"]))
    await settle()
    expect([...element.children].map((child) => child.textContent), "appended, then inserted before").toEqual(["a", "b"])
    expect(created, "no native element for the released target or its new children").not.toHaveBeenCalled()
    document.body!.appendChild(element)
    await settle()
    expect(testRoot.renderer.findByText("a")).toBeDefined()
  })

  it("does not send a framework update to an element native let go", async () => {
    let box: PublicInstance | null = null
    const tree = (kind: string) => (
      <div ref={(instance) => (box = instance)} data-kind={kind} style={{ width: kind === "a" ? 30 : 40, height: 10 }}>
        {kind}
      </div>
    )
    testRoot.render(tree("a"))
    const element = box as unknown as HTMLElement
    element.remove()
    await settle()
    testRoot.render(tree("b"))
    expect(element.getAttribute("data-kind")).toBe("b")
    expect(element.textContent).toBe("b")
    document.body!.appendChild(element)
    await settle()
    expect(testRoot.renderer.findByText("b")).toBeDefined()
    expect(nativeOf(element)!.style.width).toBeDefined()
  })

  it("lets code put an element into a removed subtree and take the subtree back", async () => {
    const box = mountFramework()
    const outer = document.createElement("div")
    outer.appendChild(box)
    await settle()
    expect(testRoot.renderer.getElement((box as unknown as Handle).nativeId)).toBeUndefined()
    expect(box.isConnected).toBe(false)
    document.body!.appendChild(outer)
    await settle()
    expect(testRoot.renderer.findByText("framework")).toBeDefined()
    expect(nativeOf(box)!.parentId).toBe((outer as unknown as Handle).nativeId)
  })

  it("textContent replaces what a framework element holds, natively too", async () => {
    const box = mountFramework()
    box.textContent = "replaced"
    await settle()
    expect(testRoot.renderer.findByText("framework")).toBeUndefined()
    expect(testRoot.renderer.findByText("replaced")).toBeDefined()
    box.textContent = ""
    await settle()
    expect(testRoot.renderer.findByText("replaced")).toBeUndefined()
    expect(box.childNodes).toHaveLength(0)
  })

  it("a text node's data changes what is drawn", async () => {
    const box = mountFramework()
    const text = document.createTextNode("one")
    box.textContent = ""
    box.appendChild(text)
    await settle()
    expect(testRoot.renderer.findByText("one")).toBeDefined()
    text.data = "two"
    await settle()
    expect(testRoot.renderer.findByText("one")).toBeUndefined()
    expect(testRoot.renderer.findByText("two")).toBeDefined()
  })

  it("replaceWith and replaceChildren swap framework nodes for made ones", async () => {
    const box = mountFramework()
    const made = document.createElement("div")
    made.textContent = "made"
    box.replaceWith(made)
    await settle()
    expect([...document.body!.children]).toEqual([made])
    expect(testRoot.renderer.findByText("framework")).toBeUndefined()
    expect(testRoot.renderer.findByText("made")).toBeDefined()
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
    expect(() => document.body!.insertBefore(inner, document.createElement("span"))).toThrow(
      expect.objectContaining({ name: "NotFoundError" })
    )
    expect(() => document.createElement("marquee")).toThrow(expect.objectContaining({ name: "NotSupportedError" }))
    expect(inner.parentNode).toBe(box)
    await settle()
  })

  it("refuses to move a node into another window's tree", () => {
    const window = () =>
      ({ ids: { nextElementId: 0 }, instances: new Map(), nativeRenderer: {} }) as unknown as Container
    const one = window()
    const two = window()
    const context = { isInsideText: false }
    const parent = hostConfig.createInstance("div", {}, one, context)
    const child = hostConfig.createInstance("div", {}, two, context)
    expect(() => (parent as unknown as Node).appendChild(child as unknown as Node)).toThrow(
      expect.objectContaining({ name: "HierarchyRequestError" })
    )
    expect(child.parentNode).toBeNull()
  })

  it("lets React remove a node code moved, and React's own removal wins over a pending release", async () => {
    let list: PublicInstance | null = null
    const tree = (items: string[]) => (
      <div ref={(instance) => (list = instance)}>
        {items.map((item) => (
          <span key={item} data-item={item} />
        ))}
      </div>
    )
    testRoot.render(tree(["a", "b"]))
    const element = list as unknown as HTMLElement
    const [a, b] = [...element.children]
    element.appendChild(a)
    testRoot.render(tree(["b"]))
    expect([...element.children]).toEqual([b])
    await settle()
    expect(nativeChildren(element)).toEqual(idsOf([b]))
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
