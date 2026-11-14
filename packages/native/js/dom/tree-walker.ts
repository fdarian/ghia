/**
 * `NodeFilter` and `TreeWalker`: the traversal a focus scope, `ariaHideOutside` and a menu's typeahead
 * make over the nodes of a subtree. The algorithms are the DOM standard's, over the node members
 * the nodes already have (`parentNode`, `firstChild`, `lastChild`, `previousSibling`, `nextSibling`),
 * so they walk whatever kinds of node the tree holds.
 */

import { namedError } from "../named-error.js"
import { Node } from "./nodes.js"

const FILTER_ACCEPT = 1
const FILTER_REJECT = 2
const FILTER_SKIP = 3

const SHOW_ALL = 0xffffffff

/** The `SHOW_*` bit of a node type is `1 << (nodeType - 1)`, as the standard has it. */
const NODE_FILTER_CONSTANTS = {
  FILTER_ACCEPT,
  FILTER_REJECT,
  FILTER_SKIP,
  SHOW_ALL,
  SHOW_ELEMENT: 0x1,
  SHOW_ATTRIBUTE: 0x2,
  SHOW_TEXT: 0x4,
  SHOW_CDATA_SECTION: 0x8,
  SHOW_ENTITY_REFERENCE: 0x10,
  SHOW_ENTITY: 0x20,
  SHOW_PROCESSING_INSTRUCTION: 0x40,
  SHOW_COMMENT: 0x80,
  SHOW_DOCUMENT: 0x100,
  SHOW_DOCUMENT_TYPE: 0x200,
  SHOW_DOCUMENT_FRAGMENT: 0x400,
  SHOW_NOTATION: 0x800,
} as const

/** The global `NodeFilter`: the constants a filter returns and a `whatToShow` mask is made of. It has no instances. */
export abstract class NodeFilter {
  static readonly FILTER_ACCEPT = FILTER_ACCEPT
  static readonly FILTER_REJECT = FILTER_REJECT
  static readonly FILTER_SKIP = FILTER_SKIP
  static readonly SHOW_ALL = SHOW_ALL
  static readonly SHOW_ELEMENT = NODE_FILTER_CONSTANTS.SHOW_ELEMENT
  static readonly SHOW_ATTRIBUTE = NODE_FILTER_CONSTANTS.SHOW_ATTRIBUTE
  static readonly SHOW_TEXT = NODE_FILTER_CONSTANTS.SHOW_TEXT
  static readonly SHOW_CDATA_SECTION = NODE_FILTER_CONSTANTS.SHOW_CDATA_SECTION
  static readonly SHOW_ENTITY_REFERENCE = NODE_FILTER_CONSTANTS.SHOW_ENTITY_REFERENCE
  static readonly SHOW_ENTITY = NODE_FILTER_CONSTANTS.SHOW_ENTITY
  static readonly SHOW_PROCESSING_INSTRUCTION = NODE_FILTER_CONSTANTS.SHOW_PROCESSING_INSTRUCTION
  static readonly SHOW_COMMENT = NODE_FILTER_CONSTANTS.SHOW_COMMENT
  static readonly SHOW_DOCUMENT = NODE_FILTER_CONSTANTS.SHOW_DOCUMENT
  static readonly SHOW_DOCUMENT_TYPE = NODE_FILTER_CONSTANTS.SHOW_DOCUMENT_TYPE
  static readonly SHOW_DOCUMENT_FRAGMENT = NODE_FILTER_CONSTANTS.SHOW_DOCUMENT_FRAGMENT
  static readonly SHOW_NOTATION = NODE_FILTER_CONSTANTS.SHOW_NOTATION

  constructor() {
    throw new TypeError("Illegal constructor")
  }
}

for (const [name, value] of Object.entries(NODE_FILTER_CONSTANTS)) {
  Object.defineProperty(NodeFilter.prototype, name, { value, enumerable: true })
}

export type NodeFilterCallback = (node: Node) => number
export type NodeFilterObject = { acceptNode(node: Node): number }
export type NodeFilterLike = NodeFilterCallback | NodeFilterObject

const CREATE = Symbol("create tree walker")

class TreeWalkerClass {
  readonly root: Node
  readonly whatToShow: number
  readonly filter: NodeFilterLike | null
  #current: Node
  /** A filter that walks the same walker again would loop through itself; the standard throws instead. */
  #active = false

  constructor(token: symbol, root: Node, whatToShow: number, filter: NodeFilterLike | null) {
    if (token !== CREATE) throw new TypeError("Illegal constructor")
    this.root = root
    this.whatToShow = whatToShow
    this.filter = filter
    this.#current = root
  }

  get currentNode(): Node {
    return this.#current
  }

  set currentNode(node: Node) {
    if (!(node instanceof Node)) throw new TypeError("Failed to set currentNode on TreeWalker: the value is not a Node")
    this.#current = node
  }

  parentNode(): Node | null {
    let node: Node | null = this.#current
    while (node !== null && node !== this.root) {
      node = node.parentNode
      if (node !== null && this.accepts(node) === FILTER_ACCEPT) {
        this.#current = node
        return node
      }
    }
    return null
  }

  firstChild(): Node | null {
    return this.traverseChildren(true)
  }

  lastChild(): Node | null {
    return this.traverseChildren(false)
  }

  previousSibling(): Node | null {
    return this.traverseSiblings(false)
  }

  nextSibling(): Node | null {
    return this.traverseSiblings(true)
  }

  previousNode(): Node | null {
    let node = this.#current
    while (node !== this.root) {
      let sibling = node.previousSibling
      while (sibling !== null) {
        node = sibling
        let result = this.accepts(node)
        while (result !== FILTER_REJECT && node.lastChild !== null) {
          node = node.lastChild
          result = this.accepts(node)
        }
        if (result === FILTER_ACCEPT) {
          this.#current = node
          return node
        }
        sibling = node.previousSibling
      }
      const parent: Node | null = node.parentNode
      if (node === this.root || parent === null) return null
      node = parent
      if (this.accepts(node) === FILTER_ACCEPT) {
        this.#current = node
        return node
      }
    }
    return null
  }

  nextNode(): Node | null {
    let node = this.#current
    let result = FILTER_ACCEPT
    for (;;) {
      while (result !== FILTER_REJECT && node.firstChild !== null) {
        node = node.firstChild
        result = this.accepts(node)
        if (result === FILTER_ACCEPT) {
          this.#current = node
          return node
        }
      }
      let following: Node | null = null
      let climbing: Node | null = node
      while (climbing !== null) {
        if (climbing === this.root) return null
        following = climbing.nextSibling
        if (following !== null) {
          node = following
          break
        }
        climbing = climbing.parentNode
      }
      if (following === null) return null
      result = this.accepts(node)
      if (result === FILTER_ACCEPT) {
        this.#current = node
        return node
      }
    }
  }

  private traverseChildren(first: boolean): Node | null {
    let node = first ? this.#current.firstChild : this.#current.lastChild
    while (node !== null) {
      const result = this.accepts(node)
      if (result === FILTER_ACCEPT) {
        this.#current = node
        return node
      }
      if (result === FILTER_SKIP) {
        const child = first ? node.firstChild : node.lastChild
        if (child !== null) {
          node = child
          continue
        }
      }
      while (node !== null) {
        const sibling: Node | null = first ? node.nextSibling : node.previousSibling
        if (sibling !== null) {
          node = sibling
          break
        }
        const parent: Node | null = node.parentNode
        if (parent === null || parent === this.root || parent === this.#current) return null
        node = parent
      }
    }
    return null
  }

  private traverseSiblings(next: boolean): Node | null {
    let node = this.#current
    if (node === this.root) return null
    for (;;) {
      let sibling = next ? node.nextSibling : node.previousSibling
      while (sibling !== null) {
        node = sibling
        const result = this.accepts(node)
        if (result === FILTER_ACCEPT) {
          this.#current = node
          return node
        }
        sibling = next ? node.firstChild : node.lastChild
        if (result === FILTER_REJECT || sibling === null) sibling = next ? node.nextSibling : node.previousSibling
      }
      const parent: Node | null = node.parentNode
      if (parent === null || parent === this.root) return null
      node = parent
      if (this.accepts(node) === FILTER_ACCEPT) return null
    }
  }

  /** The standard's "filter" step: the `whatToShow` mask first, then the callback. */
  private accepts(node: Node): number {
    if (this.#active) throw namedError("InvalidStateError", "The TreeWalker's filter is already running")
    if ((this.whatToShow & (1 << (node.nodeType - 1))) === 0) return FILTER_SKIP
    if (this.filter === null) return FILTER_ACCEPT
    this.#active = true
    try {
      const result = typeof this.filter === "function" ? this.filter(node) : this.filter.acceptNode(node)
      return Number(result) & 0xffff
    } finally {
      this.#active = false
    }
  }
}

export type TreeWalker = TreeWalkerClass
export const TreeWalker = TreeWalkerClass

/** `document.createTreeWalker(root, whatToShow, filter)`: `whatToShow` is every node by default, and the filter a function, an object with `acceptNode`, or none. */
export function createTreeWalker(root: Node, whatToShow: number = SHOW_ALL, filter: NodeFilterLike | null = null): TreeWalker {
  if (!(root instanceof Node)) throw new TypeError("Failed to execute 'createTreeWalker' on 'Document': parameter 1 is not of type 'Node'")
  if (filter !== null && typeof filter !== "function" && typeof filter !== "object") {
    throw new TypeError("Failed to execute 'createTreeWalker' on 'Document': parameter 3 is not a function or an object")
  }
  return new TreeWalkerClass(CREATE, root, whatToShow >>> 0, filter)
}
