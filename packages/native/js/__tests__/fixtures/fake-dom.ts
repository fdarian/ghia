import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type TextBinding } from "../../dom/nodes.js"
import { hasLiveRanges, liveRangesAfterInsert, liveRangesBeforeRemove } from "../../dom/live-ranges.js"
import { defineDomMembers } from "../../dom-members.js"
import "../../dom-globals.js"

/**
 * A tree kept the way an adapter keeps one: the two primitives of the DOM members, with the live
 * range hooks called where an adapter calls them (before a child leaves, after one is placed).
 * `bindingReads` counts how often a node's binding was read, to show what an algorithm looked at.
 */
const reads = new WeakMap<object, number>()

export function bindingReads(node: object): number {
  return reads.get(node) ?? 0
}

function countRead(node: object): void {
  reads.set(node, bindingReads(node) + 1)
}

export class FakeEl extends HTMLElement {
  parent: FakeEl | null = null
  readonly kids: Array<FakeEl | FakeTx> = []

  constructor(
    readonly type: string,
    readonly props: Record<string, unknown> = {}
  ) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    countRead(this)
    return elementBinding(this)
  }
}

export class FakeTx extends Text {
  parent: FakeEl | null = null

  constructor(public text: string) {
    super()
  }

  [DOM_BINDING](): TextBinding {
    countRead(this)
    return {
      parent: this.parent as Node | null,
      children: [],
      connected: true,
      root: null,
      data: this.text,
      setData: (data) => {
        this.text = data
      },
      createText: (data) => new FakeTx(data) as unknown as Text,
    }
  }
}

function detach(node: FakeEl | FakeTx): void {
  const parent = node.parent
  if (parent === null) return
  const index = parent.kids.indexOf(node)
  if (hasLiveRanges()) liveRangesBeforeRemove(parent as unknown as Node, node as unknown as Node, index)
  parent.kids.splice(index, 1)
  node.parent = null
}

function elementBinding(element: FakeEl): ElementBinding {
  return {
    parent: element.parent as Node | null,
    children: element.kids as readonly Node[],
    connected: true,
    root: null,
    type: element.type,
    prop: (name) => element.props[name],
    propNames: () => Object.keys(element.props),
    style: {},
    assertSameWindow() {},
    insertBefore(child, before) {
      const node = child as unknown as FakeEl | FakeTx
      detach(node)
      const index = before === null ? element.kids.length : element.kids.indexOf(before as unknown as FakeEl)
      element.kids.splice(index, 0, node)
      node.parent = element
      if (hasLiveRanges()) liveRangesAfterInsert(element as unknown as Node, index, 1)
    },
    removeChild(child) {
      detach(child as unknown as FakeEl | FakeTx)
    },
    createText: (data) => new FakeTx(data) as unknown as Text,
  }
}

defineDomMembers(FakeEl.prototype, (element: FakeEl) => ({
  listeners: undefined as never,
  style: {},
  connected: true,
  prop: (name) => element.props[name],
  propNames: () => Object.keys(element.props),
  setProp(name, value) {
    if (value === undefined) delete element.props[name]
    else element.props[name] = value
  },
}))

export function el(type: string, ...children: Array<FakeEl | FakeTx>): FakeEl {
  const element = new FakeEl(type)
  for (const child of children) {
    child.parent = element
    element.kids.push(child)
  }
  return element
}

export function editable(type: string, ...children: Array<FakeEl | FakeTx>): FakeEl {
  const element = el(type, ...children)
  element.props.contenteditable = "true"
  return element
}

/** A `contenteditable="false"` element inside an editing host. */
export function island(type: string, ...children: Array<FakeEl | FakeTx>): FakeEl {
  const element = el(type, ...children)
  element.props.contenteditable = "false"
  return element
}

export function tx(text: string): FakeTx {
  return new FakeTx(text)
}

export const n = (node: FakeEl | FakeTx): Node => node as unknown as Node
