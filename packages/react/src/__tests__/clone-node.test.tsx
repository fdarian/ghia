/**
 * `cloneNode` on a node React rendered: a copy with the attributes and the live style, in no
 * tree until code inserts it, that React never updates and that has none of the original's
 * handlers. `@dnd-kit/dom` clones the dragged element this way for its placeholder.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document, SVGElement } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Handle = { nativeId: number }
type Rendered = { kind: string; width: number }

describeNative("cloneNode on React nodes", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  const observers: MutationObserver[] = []
  const clicks: string[] = []

  beforeEach(() => {
    testRoot = createTestRoot()
    clicks.length = 0
  })

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    testRoot.unmount()
  })

  async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    testRoot.renderer.flush()
  }

  function mount(initial: Rendered): { box: HTMLElement; rerender: (next: Rendered) => void } {
    let box: PublicInstance | null = null
    const tree = (props: Rendered) => (
      <div
        ref={(instance) => (box = instance ?? box)}
        id="source"
        className="card"
        role="group"
        tabIndex={0}
        data-kind={props.kind}
        aria-label="the card"
        onClick={() => clicks.push("source")}
        style={{ width: props.width, height: 20, backgroundColor: "red" }}
      >
        <span data-n="1">
          hello <b>bold</b>
        </span>
        tail
      </div>
    )
    testRoot.render(tree(initial))
    return { box: box as unknown as HTMLElement, rerender: (next) => testRoot.render(tree(next)) }
  }

  function boundsOf(node: Node) {
    return testRoot.renderer.getElementBounds((node as unknown as Handle).nativeId)!
  }

  function nativeStyle(node: Node): Record<string, unknown> {
    return testRoot.renderer.getElement((node as unknown as Handle).nativeId)!.style as Record<string, unknown>
  }

  function click(node: Node): void {
    const bounds = boundsOf(node)
    testRoot.renderer.nativeSimulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  }

  it("deep-clones attributes, style (code-written custom properties included) and descendants into a disconnected node", () => {
    const { box } = mount({ kind: "a", width: 40 })
    box.style.setProperty("--x", "7")
    const clone = box.cloneNode(true) as HTMLElement
    expect(clone).not.toBe(box)
    expect(clone).toBeInstanceOf(HTMLElement)
    expect(clone.tagName).toBe("DIV")
    expect(clone.ownerDocument).toBe(document)
    expect(clone.isConnected).toBe(false)
    expect(clone.parentNode).toBeNull()
    expect((clone as unknown as Handle).nativeId).not.toBe((box as unknown as Handle).nativeId)
    expect(clone.getAttributeNames().sort()).toEqual(box.getAttributeNames().sort())
    expect(clone.id).toBe("source")
    expect(clone.className).toBe("card")
    expect(clone.getAttribute("role")).toBe("group")
    expect(clone.getAttribute("tabindex")).toBe("0")
    expect(clone.dataset.kind).toBe("a")
    expect(clone.getAttribute("aria-label")).toBe("the card")
    expect(clone.style.getPropertyValue("--x")).toBe("7")
    expect(clone.style.width).toBe("40px")
    expect(clone.childNodes).toHaveLength(2)
    expect(clone.textContent).toBe(box.textContent)
    expect(clone.textContent).toContain("bold")
    const span = clone.firstElementChild!
    expect(span).not.toBe(box.firstElementChild)
    expect(span.tagName).toBe("SPAN")
    expect((span as HTMLElement).dataset.n).toBe("1")
    expect(span.lastElementChild!.tagName).toBe("B")
    expect(clone.lastChild!.nodeType).toBe(3)
  })

  it("leaves the descendants out of a shallow clone", () => {
    const { box } = mount({ kind: "a", width: 40 })
    const clone = box.cloneNode() as HTMLElement
    expect(clone.hasChildNodes()).toBe(false)
    expect(clone.id).toBe("source")
    expect(clone.style.width).toBe("40px")
  })

  it("is drawn next to the original once inserted with insertAdjacentElement, with the style it had", async () => {
    const { box } = mount({ kind: "a", width: 40 })
    box.style.setProperty("--x", "7")
    const clone = box.cloneNode(true) as HTMLElement
    expect(box.insertAdjacentElement("afterend", clone)).toBe(clone)
    await settle()
    expect(clone.isConnected).toBe(true)
    expect([...document.body!.children]).toEqual([box, clone])
    expect(testRoot.renderer.getElement((clone as unknown as Handle).nativeId)!.parentId).toBe((document.body as unknown as Handle).nativeId)
    expect(testRoot.renderer.findByText("bold")).toBeDefined()
    const original = boundsOf(box)
    const copy = boundsOf(clone)
    expect([copy.width, copy.height]).toEqual([original.width, original.height])
    expect(copy.x !== original.x || copy.y !== original.y).toBe(true)
    expect(nativeStyle(clone)["--x"]).toBe("7")
    expect(nativeStyle(clone).width).toBe(40)
  })

  it("is not updated by React when the original changes, and does not change the original", async () => {
    const { box, rerender } = mount({ kind: "a", width: 40 })
    const clone = box.cloneNode(true) as HTMLElement
    box.insertAdjacentElement("afterend", clone)
    await settle()
    rerender({ kind: "b", width: 70 })
    expect(box.dataset.kind).toBe("b")
    expect(box.style.width).toBe("70px")
    expect(clone.dataset.kind).toBe("a")
    expect(clone.style.width).toBe("40px")
    expect(boundsOf(clone).width).toBe(40)
    clone.style.width = "10px"
    expect(box.style.width).toBe("70px")
  })

  it("has none of the original's click handler or listeners", async () => {
    const { box } = mount({ kind: "a", width: 40 })
    box.addEventListener("click", () => clicks.push("listener"))
    const clone = box.cloneNode(true) as HTMLElement
    box.insertAdjacentElement("afterend", clone)
    await settle()
    click(clone)
    expect(clicks).toEqual([])
    click(box)
    expect(clicks).toEqual(["source", "listener"])
  })

  it("tells a MutationObserver about the insertion", async () => {
    const { box } = mount({ kind: "a", width: 40 })
    const observer = new MutationObserver(() => {})
    observer.observe(document.body!, { childList: true, subtree: true, attributes: true })
    observers.push(observer)
    const clone = box.cloneNode(true) as HTMLElement
    expect(observer.takeRecords()).toEqual([])
    box.insertAdjacentElement("afterend", clone)
    const records = observer.takeRecords()
    expect(records).toHaveLength(1)
    expect(records[0].type).toBe("childList")
    expect(records[0].target).toBe(document.body)
    expect(records[0].addedNodes).toEqual([clone])
    expect(records[0].previousSibling).toBe(box)
  })

  it("clones a text node, and an svg element into an svg element", () => {
    mount({ kind: "a", width: 40 })
    const text = document.createTextNode("plain")
    const textClone = text.cloneNode()
    expect(textClone).not.toBe(text)
    expect(textClone.nodeType).toBe(3)
    expect(textClone.textContent).toBe("plain")
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path") 
    const pathClone = path.cloneNode(true)
    expect(pathClone).toBeInstanceOf(SVGElement)
    expect((pathClone as unknown as SVGElement).tagName).toBe("path")
  })

  it("throws NotSupportedError for the document", () => {
    mount({ kind: "a", width: 40 })
    expect(() => document.cloneNode(true)).toThrow(expect.objectContaining({ name: "NotSupportedError" }))
  })
})
