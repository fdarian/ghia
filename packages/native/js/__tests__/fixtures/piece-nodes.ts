import { defineDomMembers } from "../../dom-members.js"
import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type NodeRoot, type TextBinding } from "../../dom/nodes.js"
import { crossRootError } from "../../dom/tree-mutation.js"
import { ElementListeners } from "../../events/element-listeners.js"
import { documentOf, installElementSource, syncWindowEventListeners } from "../../events/window-target.js"
import { createRendererState } from "../../renderer-state.js"
import type { TestRenderer } from "../../testing.js"

/** A node of one window, kept the way the Solid adapter keeps one: it belongs to a window once it is in that window's tree. */
export class Piece extends HTMLElement {
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

export class PieceText extends Text {
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

/**
 * What an adapter's window factory does for a window `window.open` made: mounts an empty root
 * (`<html>` with `<head>` and `<body>`, and the node makers) on `renderer`, and returns how to unmount it.
 */
export function mountEmptyRoot(renderer: TestRenderer): () => void {
  const html = new Piece("html")
  const head = new Piece("head")
  const body = new Piece("body")
  const root: NodeRoot = { nativeRenderer: renderer }
  html.rootOf = renderer
  for (const child of [head, body]) {
    child.parent = html
    html.kids.push(child)
  }
  for (const node of [html, head, body]) node.root = root
  const binding = createRendererState(renderer).attach()
  const stop = installElementSource(renderer, () => undefined, () => ({ html, head, body }), {
    createElement: (type) => new Piece(type),
    createTextNode: (data) => new PieceText(data) as unknown as Text,
    createDocumentFragment: () => {
      throw new Error("not used")
    },
  })
  const stopListeners = syncWindowEventListeners(renderer)
  return () => {
    stopListeners()
    stop()
    binding.detach()
  }
}
