/**
 * A document and a window target per renderer: two test windows at once, each with its own tree,
 * `document` and `window`. The first window's are the global ones; an event in the second's tree
 * reaches its own document and window and nobody else's.
 */
import { describe, expect, it } from "vitest"
import "../dom-globals.js"
import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type NodeRoot, type TextBinding } from "../dom/nodes.js"
import { crossRootError } from "../dom/tree-mutation.js"
import { defineDomMembers } from "../dom-members.js"
import { ElementListeners } from "../events/element-listeners.js"
import {
  document,
  documentOf,
  forgetElementSource,
  forgetWindowSource,
  globalWindow,
  installElementSource,
  syncWindowEventListeners,
  windowOf,
  window as globalTarget,
  type GpuixDocument,
} from "../events/window-target.js"
import { createRendererState } from "../renderer-state.js"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"

/** A node of one window, kept the way the Solid adapter keeps one: it belongs to a window once it is in that window's tree. */
class Piece extends HTMLElement {
  parent: Piece | PieceText | null = null
  readonly kids: Array<Piece | PieceText> = []
  readonly props: Record<string, unknown> = {}
  readonly listeners = new ElementListeners()
  root: NodeRoot | null = null
  /** The window's `<html>`: its parent is that window's document. */
  rootOf: NativeRenderer | null = null

  constructor(readonly type: string) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    return pieceBinding(this)
  }
}

type NativeRenderer = TestRenderer

class PieceText extends Text {
  parent: Piece | null = null
  root: NodeRoot | null = null

  constructor(public text: string) {
    super()
  }

  [DOM_BINDING](): TextBinding {
    const self = this
    return {
      get parent() {
        return self.parent as unknown as Node | null
      },
      children: [],
      get connected() {
        return self.root !== null
      },
      get root() {
        return self.root
      },
      data: this.text,
      setData: (data) => {
        this.text = data
      },
      createText: (data) => new PieceText(data) as unknown as Text,
      createFragment: () => {
        throw new Error("not used")
      },
    }
  }
}

function setRoot(node: Piece | PieceText, root: NodeRoot | null): void {
  node.root = root
  if (node instanceof Piece) for (const child of node.kids) setRoot(child, root)
}

function pieceBinding(element: Piece): ElementBinding {
  return {
    get parent() {
      if (element.parent !== null) return element.parent as unknown as Node
      return element.rootOf === null ? null : (documentOf(element.rootOf) as unknown as Node)
    },
    children: element.kids as unknown as readonly Node[],
    get connected() {
      return element.root !== null
    },
    get root() {
      return element.root
    },
    type: element.type,
    prop: (name) => element.props[name],
    propNames: () => Object.keys(element.props),
    style: {},
    // The Solid rule: a node a window mounted cannot go into another window's tree, and one nobody mounted can.
    assertSameWindow(child) {
      const root = (child as unknown as Piece).root
      if (root !== null && root !== element.root) throw crossRootError()
    },
    insertBefore(child, before) {
      const node = child as unknown as Piece | PieceText
      if (node.parent !== null) node.parent.kids.splice(node.parent.kids.indexOf(node), 1)
      const index = before === null ? element.kids.length : element.kids.indexOf(before as unknown as Piece)
      element.kids.splice(index, 0, node)
      node.parent = element
      setRoot(node, element.root)
    },
    removeChild(child) {
      const node = child as unknown as Piece | PieceText
      element.kids.splice(element.kids.indexOf(node), 1)
      node.parent = null
    },
    createText: (data) => new PieceText(data) as unknown as Text,
    createElement: (type) => new Piece(type) as never,
    createFragment: () => {
      throw new Error("not used")
    },
  }
}

defineDomMembers(Piece.prototype, (element: Piece) => ({
  listeners: element.listeners,
  style: {},
  get connected() {
    return element.root !== null
  },
  layout: undefined,
  prop: (name) => element.props[name],
  propNames: () => Object.keys(element.props),
  setProp(name, value) {
    if (value === undefined) delete element.props[name]
    else element.props[name] = value
  },
}))

type Op = unknown[]

/** One native window drawing a box of `box`, and the DOM objects its root hands out. */
interface Window {
  renderer: TestRenderer
  html: Piece
  head: Piece
  body: Piece
  /** The elements of native ids 1 and 2: the app's container and the box. */
  container: Piece
  box: Piece
  text: PieceText
  clicks: number[]
  detach(): void
}

function openWindow(width: number, height: number, box: { width: number; height: number }, label: string): Window {
  const renderer = new TestRenderer({ width, height })
  const html = new Piece("html")
  const head = new Piece("head")
  const body = new Piece("body")
  const container = new Piece("div")
  const boxElement = new Piece("div")
  const text = new PieceText(label)
  const root: NodeRoot = { nativeRenderer: renderer }
  html.rootOf = renderer
  for (const [parent, child] of [[html, head], [html, body], [body, container], [container, boxElement], [boxElement, text]] as const) {
    child.parent = parent
    parent.kids.push(child)
  }
  for (const node of [html, head, body, container, boxElement, text]) node.root = root
  const ids = new Map<number, Piece>([[1, container], [2, boxElement]])
  const ops: Op[] = [
    ["createElement", 1, "div"],
    ["setRoot", 1],
    ["setStyle", 1, { display: "flex", flexDirection: "column", alignItems: "flex-start" }],
    ["createElement", 2, "div"],
    ["appendChild", 1, 2],
    ["setStyle", 2, box],
    ["setEventListener", 2, "click", true],
    ["setCustomProp", 1, "tabIndex", 0],
    ["setCustomProp", 2, "tabIndex", 0],
    ["createElement", 3, "#text"],
    ["appendChild", 2, 3],
    ["setText", 3, label],
  ]
  renderer.applyBatch(encodeWireBatchForTest(ops))
  renderer.flush()
  const binding = createRendererState(renderer).attach()
  const stop = installElementSource(
    renderer,
    (id) => ids.get(id),
    () => ({ html, head, body }),
    {
      createElement: (type) => new Piece(type),
      createTextNode: (data) => new PieceText(data) as unknown as Text,
      createDocumentFragment: () => {
        throw new Error("not used")
      },
    }
  )
  const stopListeners = syncWindowEventListeners(renderer)
  const clicks: number[] = []
  return {
    renderer,
    html,
    head,
    body,
    container,
    box: boxElement,
    text,
    clicks,
    detach() {
      stopListeners()
      stop()
      binding.detach()
    },
  }
}

describe.skipIf(!hasNativeTestRenderer)("a document and a window target per renderer", () => {
  it("gives the first window the global document and every later window its own", () => {
    const first = openWindow(600, 400, { width: 120, height: 40 }, "first window")
    const second = openWindow(300, 500, { width: 80, height: 90 }, "second window")
    try {
      expect(documentOf(first.renderer)).toBe(document)
      expect(globalThis.document).toBe(document)
      expect(documentOf(second.renderer)).not.toBe(document)
      expect(windowOf(first.renderer)).toBe(globalWindow())
      expect(windowOf(second.renderer)).not.toBe(globalWindow())
      expect(documentOf(second.renderer).window).toBe(windowOf(second.renderer))
      expect(documentOf(first.renderer).defaultView).toBe(globalThis)
      expect(documentOf(second.renderer).defaultView).toBe(windowOf(second.renderer))
    } finally {
      first.detach()
      second.detach()
    }
  })

  it("answers html, head, body, readyState and visibilityState for its own window", () => {
    const first = openWindow(600, 400, { width: 120, height: 40 }, "first window")
    const second = openWindow(300, 500, { width: 80, height: 90 }, "second window")
    try {
      const firstDocument = documentOf(first.renderer)
      const secondDocument = documentOf(second.renderer)
      expect([firstDocument.documentElement, firstDocument.head, firstDocument.body]).toEqual([first.html, first.head, first.body])
      expect([secondDocument.documentElement, secondDocument.head, secondDocument.body]).toEqual([second.html, second.head, second.body])
      expect(document.body).toBe(first.body)
      expect(secondDocument.scrollingElement).toBe(second.html)
      expect(secondDocument.childNodes).toEqual([second.html])
      expect(first.html.parentNode).toBe(firstDocument)
      expect(second.html.parentNode).toBe(secondDocument)
      expect(second.body.ownerDocument).toBe(secondDocument)
      expect(second.body.getRootNode()).toBe(secondDocument)
      expect(first.body.getRootNode()).toBe(document)
      expect([firstDocument.readyState, firstDocument.visibilityState, secondDocument.hidden]).toEqual(["complete", "visible", false])
      second.detach()
      expect([secondDocument.visibilityState, secondDocument.hidden]).toEqual(["hidden", true])
      // A window whose root is gone has fresh empty roots, not the old tree.
      expect(secondDocument.body).not.toBe(second.body)
      expect(secondDocument.body.childNodes).toEqual([])
    } finally {
      first.detach()
      second.detach()
    }
  })

  it("hit tests, reads the size and matches media for its own window", () => {
    const first = openWindow(600, 400, { width: 120, height: 40 }, "first window")
    const second = openWindow(300, 500, { width: 80, height: 90 }, "second window")
    try {
      const secondDocument = documentOf(second.renderer)
      expect(document.elementFromPoint(50, 20)).toBe(first.box)
      expect(secondDocument.elementFromPoint(50, 20)).toBe(second.box)
      // Past the second window's box, over the first's.
      expect(document.elementFromPoint(100, 20)).toBe(first.box)
      expect(secondDocument.elementFromPoint(100, 20)).not.toBe(second.box)
      expect(document.elementsFromPoint(50, 20)[0]).toBe(first.box)
      expect(secondDocument.elementsFromPoint(50, 20)[0]).toBe(second.box)
      expect([windowOf(first.renderer).innerWidth, windowOf(first.renderer).innerHeight]).toEqual([600, 400])
      expect([windowOf(second.renderer).innerWidth, windowOf(second.renderer).innerHeight]).toEqual([300, 500])
      expect([globalThis.innerWidth, globalThis.innerHeight]).toEqual([600, 400])
      expect(windowOf(second.renderer).visualViewport.width).toBe(300)
      expect(windowOf(first.renderer).matchMedia("(min-width: 400px)").matches).toBe(true)
      expect(windowOf(second.renderer).matchMedia("(min-width: 400px)").matches).toBe(false)
      expect(globalThis.matchMedia("(min-width: 400px)").matches).toBe(true)
    } finally {
      first.detach()
      second.detach()
    }
  })

  it("sends resize to the window that was resized", () => {
    const first = openWindow(600, 400, { width: 120, height: 40 }, "first window")
    const second = openWindow(300, 500, { width: 80, height: 90 }, "second window")
    const seen: string[] = []
    const onGlobal = () => seen.push(`global ${globalThis.innerWidth}`)
    const onSecond = () => seen.push(`second ${windowOf(second.renderer).innerWidth}`)
    globalThis.addEventListener("resize", onGlobal)
    windowOf(second.renderer).addEventListener("resize", onSecond)
    try {
      second.renderer.setWindowSize(350, 500)
      createRendererState(second.renderer).dispatch({ elementId: 0, eventType: "mediaChange", value: "resize" })
      expect(seen).toEqual(["second 350"])
      first.renderer.setWindowSize(640, 400)
      createRendererState(first.renderer).dispatch({ elementId: 0, eventType: "mediaChange", value: "resize" })
      expect(seen).toEqual(["second 350", "global 640"])
    } finally {
      globalThis.removeEventListener("resize", onGlobal)
      windowOf(second.renderer).removeEventListener("resize", onSecond)
      first.detach()
      second.detach()
    }
  })

  it("keeps a selection, a focus and the commands of each document apart", () => {
    const first = openWindow(600, 400, { width: 120, height: 40 }, "first window")
    const second = openWindow(300, 500, { width: 80, height: 90 }, "second window")
    try {
      const firstDocument = documentOf(first.renderer)
      const secondDocument = documentOf(second.renderer)
      const firstSelection = firstDocument.getSelection()
      const secondSelection = secondDocument.getSelection()
      expect(document.getSelection()).toBe(firstSelection)
      expect(secondSelection).not.toBe(firstSelection)
      firstSelection.collapse(first.text as unknown as Node, 2)
      expect([firstSelection.rangeCount, secondSelection.rangeCount]).toEqual([1, 0])
      // A node of the first window is not in the second's document, so its selection ignores it.
      secondSelection.collapse(first.text as unknown as Node, 1)
      expect(secondSelection.rangeCount).toBe(0)
      secondSelection.collapse(second.text as unknown as Node, 3)
      expect([firstSelection.anchorOffset, secondSelection.anchorOffset]).toEqual([2, 3])
      secondSelection.removeAllRanges()
      expect([firstSelection.rangeCount, secondSelection.rangeCount]).toEqual([1, 0])

      // Select all, as `execCommand` runs it, selects the body of the document it is called on.
      expect(secondDocument.execCommand("selectAll")).toBe(true)
      expect(secondSelection.anchorNode).toBe(second.body)
      expect(firstSelection.anchorNode).toBe(first.text)

      second.renderer.focusElement(2)
      expect(secondDocument.activeElement).toBe(second.box)
      expect(firstDocument.activeElement).toBe(first.body)
      first.renderer.focusElement(1)
      expect(firstDocument.activeElement).toBe(first.container)
      expect(secondDocument.activeElement).toBe(second.box)
      expect(document.activeElement).toBe(first.container)
    } finally {
      document.getSelection().removeAllRanges()
      first.detach()
      second.detach()
    }
  })

  it("keeps adoptedStyleSheets per document", () => {
    const first = openWindow(600, 400, { width: 120, height: 40 }, "first window")
    const second = openWindow(300, 500, { width: 80, height: 90 }, "second window")
    try {
      const sheet = new CSSStyleSheet()
      documentOf(second.renderer).adoptedStyleSheets = [sheet]
      expect(documentOf(second.renderer).adoptedStyleSheets).toEqual([sheet])
      expect(document.adoptedStyleSheets).toEqual([])
    } finally {
      first.detach()
      second.detach()
    }
  })

  it("keeps the global document the first window's after a second mounts, and when it goes", () => {
    const first = openWindow(600, 400, { width: 120, height: 40 }, "first window")
    const second = openWindow(300, 500, { width: 80, height: 90 }, "second window")
    expect(document.body).toBe(first.body)
    second.detach()
    forgetElementSource(second.renderer)
    expect(document.body).toBe(first.body)
    expect(documentOf(first.renderer)).toBe(document)
    // A window that mounts later does not take it over while the first's root is mounted.
    const third = openWindow(200, 200, { width: 50, height: 50 }, "third window")
    try {
      expect(document.body).toBe(first.body)
      expect(documentOf(third.renderer)).not.toBe(document)
    } finally {
      third.detach()
      first.detach()
    }
  })

  it("leaves the global document empty, and the same object, when the first window closes", () => {
    const first = openWindow(600, 400, { width: 120, height: 40 }, "first window")
    const second = openWindow(300, 500, { width: 80, height: 90 }, "second window")
    try {
      first.body.props["data-kept"] = "yes"
      expect(document.body).toBe(first.body)
      forgetWindowSource(first.renderer)
      expect(globalThis.document).toBe(document)
      expect(document.body).not.toBe(first.body)
      expect(document.body.childNodes).toEqual([])
      expect(document.documentElement.childNodes).toHaveLength(2)
      expect(document.visibilityState).toBe("hidden")
      // The second window goes on, and a window that opens later is not the global one.
      expect(documentOf(second.renderer).body).toBe(second.body)
      first.detach()
      const third = openWindow(200, 200, { width: 50, height: 50 }, "third window")
      try {
        expect(documentOf(third.renderer)).not.toBe(document)
        expect(document.body).not.toBe(third.body)
      } finally {
        third.detach()
      }
    } finally {
      second.detach()
      forgetElementSource(first.renderer)
    }
  })

  describe("events", () => {
    it("reach the document and the window target of the window they happened in, and no other window's", () => {
      const first = openWindow(400, 400, { width: 100, height: 100 }, "first")
      const second = openWindow(400, 400, { width: 100, height: 100 }, "second")
      const heard: string[] = []
      const secondWindow = windowOf(second.renderer)
      const secondDocument = documentOf(second.renderer)
      const record = (name: string) => (event: Event) => heard.push(`${name} ${event.type} ${(event.target as Piece).type}`)
      const onGlobalWindow = record("global window")
      const onGlobalDocument = record("global document")
      const onSecondWindow = record("second window")
      const onSecondDocument = record("second document")
      globalThis.addEventListener("click", onGlobalWindow)
      document.addEventListener("click", onGlobalDocument)
      secondWindow.addEventListener("click", onSecondWindow)
      secondDocument.addEventListener("click", onSecondDocument)
      try {
        second.renderer.nativeSimulateClick(50, 50)
        expect(heard).toEqual(["second document click div", "second window click div"])
        heard.length = 0
        first.renderer.nativeSimulateClick(50, 50)
        expect(heard).toEqual(["global document click div", "global window click div"])
      } finally {
        globalThis.removeEventListener("click", onGlobalWindow)
        document.removeEventListener("click", onGlobalDocument)
        secondWindow.removeEventListener("click", onSecondWindow)
        secondDocument.removeEventListener("click", onSecondDocument)
        first.detach()
        second.detach()
      }
    })

    it("have the window they happened in as their view", () => {
      const first = openWindow(400, 400, { width: 100, height: 100 }, "first")
      const second = openWindow(400, 400, { width: 100, height: 100 }, "second")
      const views: unknown[] = []
      const onClick = (event: Event) => views.push((event as unknown as { view: unknown }).view)
      document.addEventListener("click", onClick)
      documentOf(second.renderer).addEventListener("click", onClick)
      try {
        first.renderer.nativeSimulateClick(50, 50)
        second.renderer.nativeSimulateClick(50, 50)
        expect(views).toEqual([globalThis, windowOf(second.renderer)])
      } finally {
        document.removeEventListener("click", onClick)
        documentOf(second.renderer).removeEventListener("click", onClick)
        first.detach()
        second.detach()
      }
    })

    it("run through the capture and bubble of the window's own document and window with the right currentTarget", () => {
      const first = openWindow(400, 400, { width: 100, height: 100 }, "first")
      const second = openWindow(400, 400, { width: 100, height: 100 }, "second")
      const secondWindow = windowOf(second.renderer)
      const secondDocument = documentOf(second.renderer)
      const seen: Array<[string, unknown]> = []
      const listen = (name: string, target: { addEventListener(type: string, listener: (event: Event) => void, options?: boolean): void }, capture: boolean) =>
        target.addEventListener("click", (event) => seen.push([name, event.currentTarget]), capture)
      listen("window capture", secondWindow, true)
      listen("document capture", secondDocument, true)
      listen("document bubble", secondDocument, false)
      listen("window bubble", secondWindow, false)
      try {
        second.renderer.nativeSimulateClick(50, 50)
        expect(seen).toEqual([
          ["window capture", secondWindow],
          ["document capture", secondDocument],
          ["document bubble", secondDocument],
          ["window bubble", secondWindow],
        ])
      } finally {
        first.detach()
        second.detach()
      }
    })

    it("reach window listeners of a dispatchEvent on an element of the window, and no other window's", () => {
      const first = openWindow(400, 400, { width: 100, height: 100 }, "first")
      const second = openWindow(400, 400, { width: 100, height: 100 }, "second")
      const heard: string[] = []
      const onGlobal = () => heard.push("global")
      const onSecond = () => heard.push("second")
      globalThis.addEventListener("ping", onGlobal)
      windowOf(second.renderer).addEventListener("ping", onSecond)
      try {
        second.box.dispatchEvent(new Event("ping", { bubbles: true }))
        expect(heard).toEqual(["second"])
        first.box.dispatchEvent(new Event("ping", { bubbles: true }))
        expect(heard).toEqual(["second", "global"])
        documentOf(second.renderer).dispatchEvent(new Event("ping", { bubbles: true }))
        expect(heard).toEqual(["second", "global", "second"])
      } finally {
        globalThis.removeEventListener("ping", onGlobal)
        windowOf(second.renderer).removeEventListener("ping", onSecond)
        first.detach()
        second.detach()
      }
    })

    it("run the requestAnimationFrame callbacks of the window whose frame it is", () => {
      const first = openWindow(400, 400, { width: 100, height: 100 }, "first")
      const second = openWindow(400, 400, { width: 100, height: 100 }, "second")
      const ran: string[] = []
      try {
        // The global one is the first window's; the second window has its own list.
        globalThis.requestAnimationFrame(() => ran.push("global"))
        windowOf(second.renderer).requestAnimationFrame(() => ran.push("second"))
        second.renderer.drawFrame()
        expect(ran).toEqual(["second"])
        first.renderer.drawFrame()
        expect(ran).toEqual(["second", "global"])
        const cancelled = windowOf(second.renderer).requestAnimationFrame(() => ran.push("cancelled"))
        windowOf(second.renderer).cancelAnimationFrame(cancelled)
        second.renderer.drawFrame()
        expect(ran).toEqual(["second", "global"])
      } finally {
        first.detach()
        second.detach()
      }
    })
  })

  describe("nodes", () => {
    it("belong to the document whose factory made them", () => {
      const first = openWindow(400, 400, { width: 100, height: 100 }, "first")
      const second = openWindow(400, 400, { width: 100, height: 100 }, "second")
      try {
        const madeByFirst = document.createElement("section")
        const madeBySecond = documentOf(second.renderer).createElement("section")
        const text = documentOf(second.renderer).createTextNode("made")
        expect(madeByFirst.ownerDocument).toBe(document)
        expect(madeBySecond.ownerDocument).toBe(documentOf(second.renderer))
        expect(text.ownerDocument).toBe(documentOf(second.renderer))
        expect(madeBySecond.isConnected).toBe(false)
        expect(documentOf(second.renderer).createElementNS("http://www.w3.org/2000/svg", "svg").ownerDocument).toBe(documentOf(second.renderer))
      } finally {
        first.detach()
        second.detach()
      }
    })

    it("are adopted by the tree they are inserted into when no window mounted them, and a mounted one is refused", () => {
      const first = openWindow(400, 400, { width: 100, height: 100 }, "first")
      const second = openWindow(400, 400, { width: 100, height: 100 }, "second")
      const secondDocument = documentOf(second.renderer)
      try {
        const loose = document.createElement("section")
        const inner = document.createElement("span")
        loose.appendChild(inner)
        expect(inner.ownerDocument).toBe(document)
        second.body.appendChild(loose)
        expect(loose.ownerDocument).toBe(secondDocument)
        expect(inner.ownerDocument).toBe(secondDocument)
        expect(loose.isConnected).toBe(true)
        expect(loose.parentNode).toBe(second.body)

        // Into an unmounted node of another document: adopted by that node's document.
        const other = secondDocument.createElement("div")
        const wanderer = document.createElement("div")
        other.appendChild(wanderer)
        expect(wanderer.ownerDocument).toBe(secondDocument)

        // A node the first window mounted stays in it.
        expect(() => second.body.appendChild(first.box as unknown as Node)).toThrow(expect.objectContaining({ name: "HierarchyRequestError" }))
        expect(first.box.parentNode).toBe(first.container)
        expect(() => other.appendChild(first.box as unknown as Node)).toThrow(expect.objectContaining({ name: "HierarchyRequestError" }))
      } finally {
        first.detach()
        second.detach()
      }
    })

    it("move with adoptNode and importNode, which a window's mounted node refuses", () => {
      const first = openWindow(400, 400, { width: 100, height: 100 }, "first")
      const second = openWindow(400, 400, { width: 100, height: 100 }, "second")
      const secondDocument = documentOf(second.renderer) as GpuixDocument
      try {
        const loose = document.createElement("div")
        const child = document.createElement("span")
        loose.appendChild(child)
        expect(secondDocument.adoptNode(loose)).toBe(loose)
        expect(loose.ownerDocument).toBe(secondDocument)
        expect(child.ownerDocument).toBe(secondDocument)

        const imported = secondDocument.importNode(first.box as unknown as Node, true) as unknown as Piece
        expect(imported).not.toBe(first.box)
        expect(imported.ownerDocument).toBe(secondDocument)
        expect(imported.isConnected).toBe(false)
        expect(first.box.ownerDocument).toBe(document)

        expect(() => secondDocument.adoptNode(first.box as unknown as Node)).toThrow(expect.objectContaining({ name: "HierarchyRequestError" }))
        expect(() => secondDocument.adoptNode(secondDocument as unknown as Node)).toThrow(expect.objectContaining({ name: "NotSupportedError" }))
        // Adopting a node into the document that owns it takes it out of its tree.
        const own = secondDocument.createElement("p")
        second.body.appendChild(own)
        expect(secondDocument.adoptNode(own)).toBe(own)
        expect(own.parentNode).toBeNull()
      } finally {
        first.detach()
        second.detach()
      }
    })
  })

  it("lets a window that was released leave its renderer's window to the next one", () => {
    const first = openWindow(400, 400, { width: 100, height: 100 }, "first")
    expect(documentOf(first.renderer)).toBe(document)
    first.detach()
    forgetElementSource(first.renderer)
    const next = openWindow(400, 400, { width: 100, height: 100 }, "next")
    try {
      expect(documentOf(next.renderer)).toBe(document)
      expect(document.body).toBe(next.body)
      expect(globalTarget).toBe(windowOf(next.renderer).events)
    } finally {
      next.detach()
    }
  })
})
