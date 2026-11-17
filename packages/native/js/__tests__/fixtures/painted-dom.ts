/**
 * A small DOM whose Text nodes and elements are "mounted" in a fake renderer that answers the three
 * reads of the painted text from scripts, so the JS half of the geometry (which node ids are asked
 * about, how the answers become rects, positions and selection moves) is tested without a window.
 */

import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type TextBinding } from "../../dom/nodes.js"
import { hasLiveRanges, liveRangesAfterInsert, liveRangesBeforeRemove } from "../../dom/live-ranges.js"
import { defineDomMembers } from "../../dom-members.js"
import { ElementListeners } from "../../events/element-listeners.js"
import type { CaretPoint, ElementBounds, NativeRenderer, TextRect } from "../../host.js"

export interface ScriptedWindow {
  readonly renderer: NativeRenderer
  /** Every `getTextRangeRects` call, as `[startId, startOffset, endId, endOffset]`. */
  readonly rectCalls: number[][]
  readonly moveCalls: Array<{ nodeId: number; offset: number; op: string; goalX: number | null | undefined }>
  readonly pointCalls: Array<[number, number]>
  /** What `getTextRangeRects` answers for a node, from its range. */
  rects: (nodeId: number, start: number, end: number) => TextRect[]
  /** What `moveCaretVisually` answers. */
  move: (nodeId: number, offset: number, op: string, goalX: number | null | undefined) => CaretPoint | null
  point: (x: number, y: number) => CaretPoint | null
  /** The box of an element, by id. */
  bounds: Map<number, ElementBounds>
}

export function scriptedWindow(): ScriptedWindow {
  const fake = {
    rectCalls: [] as number[][],
    moveCalls: [] as ScriptedWindow["moveCalls"],
    pointCalls: [] as Array<[number, number]>,
    rects: (() => []) as ScriptedWindow["rects"],
    move: (() => null) as ScriptedWindow["move"],
    point: (() => null) as ScriptedWindow["point"],
    bounds: new Map<number, ElementBounds>(),
    applyBatch: (): number[] => [],
    getSelectedText: (): string | null => null,
    clearSelection: (): void => {},
    setWindowSelectionChange: (): void => {},
    getElementBounds(id: number): ElementBounds | null {
      return fake.bounds.get(id) ?? null
    },
    getTextRangeRects(startId: number, startOffset: number, endId: number, endOffset: number): TextRect[] {
      fake.rectCalls.push([startId, startOffset, endId, endOffset])
      return fake.rects(startId, startOffset, endOffset)
    },
    caretPositionFromPoint(x: number, y: number): CaretPoint | null {
      fake.pointCalls.push([x, y])
      return fake.point(x, y)
    },
    moveCaretVisually(nodeId: number, offset: number, op: string, goalX?: number | null): CaretPoint | null {
      fake.moveCalls.push({ nodeId, offset, op, goalX })
      return fake.move(nodeId, offset, op, goalX)
    },
  }
  return Object.assign(fake, { renderer: fake as unknown as NativeRenderer })
}

let nextId = 1

export class FakeEl extends HTMLElement {
  parent: FakeEl | null = null
  readonly kids: Array<FakeEl | FakeTx> = []
  readonly listeners = new ElementListeners()
  readonly id = nextId++
  window: ScriptedWindow | undefined

  constructor(
    readonly type: string,
    readonly props: Record<string, unknown> = {}
  ) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    return elementBinding(this)
  }
}

export class FakeTx extends Text {
  parent: FakeEl | null = null
  readonly id = nextId++
  window: ScriptedWindow | undefined

  constructor(public text: string) {
    super()
  }

  [DOM_BINDING](): TextBinding {
    return {
      parent: this.parent as Node | null,
      children: [],
      connected: true,
      root: null,
      data: this.text,
      native: this.window === undefined ? undefined : { renderer: this.window.renderer, id: this.id },
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
  listeners: element.listeners,
  style: {},
  connected: true,
  layout: element.window === undefined ? undefined : { renderer: element.window.renderer, id: element.id },
  prop: (name) => element.props[name],
  propNames: () => Object.keys(element.props),
  setProp(name, value) {
    if (value === undefined) delete element.props[name]
    else element.props[name] = value
  },
}))

export const asNode = (node: FakeEl | FakeTx): Node => node as unknown as Node

/** Builds `type` with the children, and mounts the whole subtree in `window`. */
export function el(window: ScriptedWindow, type: string, ...children: Array<FakeEl | FakeTx>): FakeEl {
  const element = new FakeEl(type)
  element.window = window
  for (const child of children) {
    child.parent = element
    element.kids.push(child)
  }
  return element
}

export function tx(window: ScriptedWindow, text: string): FakeTx {
  const node = new FakeTx(text)
  node.window = window
  return node
}

export function box(x: number, y: number, width: number, height: number): ElementBounds {
  return { x, y, width, height, layoutWidth: width, layoutHeight: height, clientLeft: 0, clientTop: 0 } as unknown as ElementBounds
}
