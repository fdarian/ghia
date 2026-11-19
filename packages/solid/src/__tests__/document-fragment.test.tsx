/** `document.createDocumentFragment()` and the Range content methods over a Solid tree. */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

type Handle = { nativeId: number }

describe.skipIf(!hasNativeTestRenderer)("DocumentFragment in Solid", () => {
  let app: ReturnType<typeof createTestRoot>
  const observers: MutationObserver[] = []

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    app.unmount()
  })

  async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    app.renderer.flush()
  }

  function mountHost(): HTMLElement {
    app.render(() => (
      <div id="host">
        <p>one</p>
        <p>two</p>
      </div>
    ))
    return document.body!.firstElementChild as HTMLElement
  }

  function tags(parent: Node): string[] {
    return Array.from(parent.childNodes).map((node) => (node.nodeType === 3 ? `"${node.textContent}"` : (node as Element).tagName.toLowerCase()))
  }

  it("holds created nodes and moves them in order into a mounted tree, drawn once", async () => {
    const host = mountHost()
    const fragment = document.createDocumentFragment()
    expect(fragment.nodeType).toBe(11)
    const first = document.createElement("section")
    first.append("added ")
    const bold = document.createElement("b")
    bold.textContent = "bold"
    first.append(bold)
    fragment.append(first, " tail")
    expect(fragment.childNodes).toHaveLength(2)
    expect(fragment.isConnected).toBe(false)

    expect(host.appendChild(fragment)).toBe(fragment)
    await settle()

    expect(fragment.childNodes).toHaveLength(0)
    expect(tags(host)).toEqual(["p", "p", "section", '" tail"'])
    expect(first.parentNode).toBe(host)
    expect(first.isConnected).toBe(true)
    expect(app.renderer.findByText("added")).toBeDefined()
    expect(app.renderer.findByText("bold")).toBeDefined()
    expect(app.renderer.findByText("tail")).toBeDefined()
    expect(app.renderer.getElement((first as unknown as Handle).nativeId)!.parentId).toBe((host as unknown as Handle).nativeId)
    expect(app.renderer.findByType("#document-fragment")).toEqual([])
  })

  it("inserts before a reference node and tells a MutationObserver of each child", async () => {
    const host = mountHost()
    const observer = new MutationObserver(() => {})
    observer.observe(host, { childList: true })
    observers.push(observer)
    const fragment = document.createDocumentFragment()
    const a = document.createElement("i")
    const b = document.createElement("u")
    fragment.append(a, b)
    host.insertBefore(fragment, host.lastChild)
    // Before the records are delivered to the callback.
    const records = observer.takeRecords()
    await settle()
    expect(tags(host)).toEqual(["p", "i", "u", "p"])
    expect(records.map((record) => record.type)).toEqual(["childList", "childList"])
    expect(records.map((record) => record.target === host)).toEqual([true, true])
    expect(records.map((record) => record.addedNodes.length)).toEqual([1, 1])
    expect(records[0].addedNodes[0] === a).toBe(true)
    expect(records[1].addedNodes[0] === b).toBe(true)
  })

  it("a mounted node moved into a fragment leaves the document and comes back drawn", async () => {
    const host = mountHost()
    const second = host.lastElementChild!
    const fragment = document.createDocumentFragment()
    fragment.appendChild(second)
    await settle()
    expect(tags(host)).toEqual(["p"])
    expect(second.isConnected).toBe(false)
    expect(app.renderer.findByText("two")).toBeUndefined()
    host.insertBefore(fragment, host.firstChild)
    await settle()
    expect(tags(host)).toEqual(["p", "p"])
    expect(host.firstElementChild).toBe(second)
    expect(app.renderer.findByText("two")).toBeDefined()
  })

  it("moves a live range with the children that leave and arrive", async () => {
    const host = mountHost()
    const range = new Range()
    range.setStart(host, 1)
    range.setEnd(host, 2)
    const fragment = document.createDocumentFragment()
    fragment.append(document.createElement("i"), document.createElement("u"))
    host.insertBefore(fragment, host.firstChild)
    expect([range.startOffset, range.endOffset]).toEqual([3, 4])
    expect(range.toString()).toBe("two")
  })

  it("extractContents across two paragraphs gives a fragment that draws elsewhere", async () => {
    app.render(() => (
      <>
        <div id="host">
          <p>one</p>
          <p>two</p>
        </div>
        <div id="target" />
      </>
    ))
    const host = document.body!.firstElementChild as HTMLElement
    const target = document.body!.lastElementChild as HTMLElement
    const range = new Range()
    range.setStart(host.children[0].firstChild!, 1)
    range.setEnd(host.children[1].firstChild!, 2)
    expect(range.toString()).toBe("netw")

    const cloned = range.cloneContents()
    expect(cloned.textContent).toBe("netw")
    expect(host.textContent).toBe("onetwo")

    const fragment = range.extractContents()
    expect(host.textContent).toBe("oo")
    expect(range.collapsed).toBe(true)
    expect(fragment.childNodes).toHaveLength(2)
    expect((fragment.firstChild as Element).tagName).toBe("P")
    target.appendChild(fragment)
    await settle()
    expect(tags(target)).toEqual(["p", "p"])
    expect(target.textContent).toBe("netw")
    expect(app.renderer.findByText("ne")).toBeDefined()
    expect(app.renderer.findByText("tw")).toBeDefined()
    expect(app.renderer.findByText("one")).toBeUndefined()
    expect(app.renderer.findByText("two")).toBeUndefined()
  })

  it("surroundContents wraps a drawn text in a created element", async () => {
    const host = mountHost()
    const text = host.firstElementChild!.firstChild!
    const range = new Range()
    range.setStart(text, 1)
    range.setEnd(text, 2)
    const wrapper = document.createElement("mark")
    range.surroundContents(wrapper)
    await settle()
    expect(host.firstElementChild!.textContent).toBe("one")
    expect(wrapper.textContent).toBe("n")
    expect(wrapper.parentNode).toBe(host.firstElementChild)
    expect(app.renderer.findByType("mark")).toHaveLength(1)
  })
})
