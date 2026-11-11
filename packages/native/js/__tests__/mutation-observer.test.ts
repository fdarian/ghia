import v8 from "node:v8"
import vm from "node:vm"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineDomMembers } from "../dom-members.js"
import { DOM_BINDING, HTMLElement, Node, SVGElement, Text, type ElementBinding, type TextBinding } from "../dom/nodes.js"
import {
  hasMutationObservers,
  MutationObserver,
  MutationRecord,
  queueAttributeMutation,
  queueCharacterDataMutation,
  queueChildListMutation,
  recordAttributeChanges,
} from "../dom/mutation-observer.js"
import "../dom-globals.js"

type Props = Record<string, unknown>

class FakeElement extends HTMLElement {
  parent: FakeElement | null = null
  readonly kids: Array<FakeElement | FakeText> = []
  props: Props
  constructor(
    readonly type: string,
    props: Props = {}
  ) {
    super()
    this.props = props
  }
  [DOM_BINDING](): ElementBinding {
    return {
      parent: this.parent,
      children: this.kids,
      connected: true,
      root: null,
      type: this.type,
      prop: (name) => this.props[name],
      propNames: () => Object.keys(this.props),
    }
  }
}

class FakeText extends Text {
  parent: FakeElement | null = null
  constructor(public text: string) {
    super()
  }
  [DOM_BINDING](): TextBinding {
    return { parent: this.parent, children: [], connected: true, root: null, data: this.text }
  }
}

class FakeSvg extends SVGElement {
  readonly kids: FakeElement[] = []
  constructor(
    readonly type: string,
    readonly props: Props = {}
  ) {
    super()
  }
  [DOM_BINDING](): ElementBinding {
    return {
      parent: null,
      children: this.kids,
      connected: true,
      root: null,
      type: this.type,
      prop: (name) => this.props[name],
      propNames: () => Object.keys(this.props),
    }
  }
}

for (const prototype of [FakeElement.prototype, FakeSvg.prototype]) {
  defineDomMembers(prototype, (element: FakeElement | FakeSvg) => ({
    listeners: undefined as never,
    connected: true,
    prop: (name) => element.props[name],
    propNames: () => Object.keys(element.props),
  }))
}

type Child = FakeElement | FakeText

/** What an adapter does around its own tree change. */
function append(parent: FakeElement, child: Child): void {
  child.parent = parent
  const previous = parent.kids[parent.kids.length - 1] ?? null
  parent.kids.push(child)
  queueChildListMutation(parent, [child], [], previous, null)
}

function remove(child: Child): void {
  const parent = child.parent
  if (parent === null) throw new Error("not placed")
  const index = parent.kids.indexOf(child)
  const previous = parent.kids[index - 1] ?? null
  const next = parent.kids[index + 1] ?? null
  parent.kids.splice(index, 1)
  child.parent = null
  queueChildListMutation(parent, [], [child], previous, next)
}

function setProp(element: FakeElement, name: string, value: unknown): void {
  const apply = () => {
    if (value === undefined) delete element.props[name]
    else element.props[name] = value
  }
  if (hasMutationObservers()) recordAttributeChanges(element, [name], apply)
  else apply()
}

function setText(text: FakeText, value: string): void {
  const old = text.text
  text.text = value
  queueCharacterDataMutation(text, old)
}

const live: MutationObserver[] = []

function observer(callback: (records: MutationRecord[], self: MutationObserver) => void): MutationObserver {
  const made = new MutationObserver(callback)
  live.push(made)
  return made
}

afterEach(() => {
  for (const made of live.splice(0)) made.disconnect()
})

describe("MutationObserver", () => {
  it("is a global, with an illegal MutationRecord constructor", () => {
    expect(globalThis.MutationObserver).toBe(MutationObserver)
    expect(globalThis.MutationRecord).toBe(MutationRecord)
    expect(() => Reflect.construct(MutationRecord, [])).toThrow(new TypeError("Illegal constructor"))
    expect(() => new (MutationObserver as unknown as new (callback: unknown) => unknown)(1)).toThrow(TypeError)
  })

  it("reports a child added, with its siblings, in one microtask", async () => {
    const parent = new FakeElement("div")
    const first = new FakeElement("span")
    append(parent, first)
    const callback = vi.fn()
    observer(callback).observe(parent, { childList: true })
    const second = new FakeText("x")
    const third = new FakeElement("b")
    append(parent, second)
    append(parent, third)
    expect(callback).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(1)
    const records = callback.mock.calls[0][0] as MutationRecord[]
    expect(records).toHaveLength(2)
    expect(records[0]).toBeInstanceOf(MutationRecord)
    expect(records[0].type).toBe("childList")
    expect(records[0].target).toBe(parent)
    expect(records[0].addedNodes).toEqual([second])
    expect(records[0].removedNodes).toEqual([])
    expect(records[0].previousSibling).toBe(first)
    expect(records[0].nextSibling).toBeNull()
    expect(records[0].attributeName).toBeNull()
    expect(records[0].attributeNamespace).toBeNull()
    expect(records[0].oldValue).toBeNull()
    expect(callback.mock.contexts[0]).toBe(live[0])
    expect(callback.mock.calls[0][1]).toBe(live[0])
  })

  it("reports a child removed with the siblings it had", async () => {
    const parent = new FakeElement("div")
    const a = new FakeElement("a")
    const b = new FakeElement("b")
    const c = new FakeElement("c")
    append(parent, a)
    append(parent, b)
    append(parent, c)
    const mo = observer(() => {})
    mo.observe(parent, { childList: true })
    remove(b)
    const records = mo.takeRecords()
    expect(records).toHaveLength(1)
    expect(records[0].removedNodes).toEqual([b])
    expect(records[0].previousSibling).toBe(a)
    expect(records[0].nextSibling).toBe(c)
  })

  it("sees only direct children without subtree, and the whole subtree with it", () => {
    const root = new FakeElement("div")
    const child = new FakeElement("div")
    append(root, child)
    const direct = observer(() => {})
    const deep = observer(() => {})
    direct.observe(root, { childList: true })
    deep.observe(root, { childList: true, subtree: true })
    append(child, new FakeElement("i"))
    expect(direct.takeRecords()).toHaveLength(0)
    expect(deep.takeRecords()).toHaveLength(1)
    append(root, new FakeElement("i"))
    expect(direct.takeRecords()).toHaveLength(1)
    expect(deep.takeRecords()).toHaveLength(1)
  })

  it("filters by the kinds of mutation asked for", () => {
    const element = new FakeElement("div", { title: "a" })
    const text = new FakeText("t")
    append(element, text)
    const mo = observer(() => {})
    mo.observe(element, { attributes: true })
    append(element, new FakeElement("p"))
    setText(text, "u")
    expect(mo.takeRecords()).toHaveLength(0)
    setProp(element, "title", "b")
    expect(mo.takeRecords()).toHaveLength(1)
  })

  describe("attributes", () => {
    it("reports the name, oldValue only on request, and honours attributeFilter", () => {
      const element = new FakeElement("div", { "data-a": "1", "data-b": "1" })
      const plain = observer(() => {})
      const withOld = observer(() => {})
      const filtered = observer(() => {})
      plain.observe(element, { attributes: true })
      withOld.observe(element, { attributeOldValue: true })
      filtered.observe(element, { attributeFilter: ["data-b"] })
      setProp(element, "data-a", "2")
      setProp(element, "data-b", "2")
      const plainRecords = plain.takeRecords()
      expect(plainRecords.map((record) => [record.attributeName, record.oldValue])).toEqual([
        ["data-a", null],
        ["data-b", null],
      ])
      expect(withOld.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
        ["data-a", "1"],
        ["data-b", "1"],
      ])
      expect(filtered.takeRecords().map((record) => record.attributeName)).toEqual(["data-b"])
    })

    it("reports null as the old value of an attribute that was added, and a removal", () => {
      const element = new FakeElement("div")
      const mo = observer(() => {})
      mo.observe(element, { attributeOldValue: true })
      setProp(element, "data-x", "1")
      setProp(element, "data-x", undefined)
      expect(mo.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
        ["data-x", null],
        ["data-x", "1"],
      ])
    })

    it("maps className to the class attribute and reads exactly what getAttribute reads", () => {
      const element = new FakeElement("div", { className: "a" })
      const mo = observer(() => {})
      mo.observe(element, { attributeOldValue: true })
      setProp(element, "className", "b")
      // `class` wins over `className` in getAttribute, so a change under it is not a change of the attribute.
      setProp(element, "class", "c")
      setProp(element, "className", "d")
      expect(mo.takeRecords().map((record) => [record.attributeName, record.oldValue])).toEqual([
        ["class", "a"],
        ["class", "b"],
      ])
    })

    it("makes no record for a handler, an object, the same value or a non-attribute prop", () => {
      const element = new FakeElement("div", { "data-a": "1" })
      const mo = observer(() => {})
      mo.observe(element, { attributes: true })
      setProp(element, "onClick", () => {})
      setProp(element, "style", { color: "red" })
      setProp(element, "children", "text")
      setProp(element, "data-a", "1")
      expect(mo.takeRecords()).toHaveLength(0)
    })

    it("sees an attribute of a descendant with subtree", () => {
      const root = new FakeElement("div")
      const child = new FakeElement("span")
      append(root, child)
      const mo = observer(() => {})
      mo.observe(root, { attributes: true, subtree: true })
      setProp(child, "id", "x")
      expect(mo.takeRecords()[0].target).toBe(child)
    })
  })

  describe("characterData", () => {
    it("reports the old text only on request", () => {
      const text = new FakeText("a")
      const plain = observer(() => {})
      const withOld = observer(() => {})
      plain.observe(text, { characterData: true })
      withOld.observe(text, { characterDataOldValue: true })
      setText(text, "b")
      expect(plain.takeRecords().map((record) => [record.type, record.oldValue])).toEqual([["characterData", null]])
      expect(withOld.takeRecords().map((record) => [record.type, record.oldValue])).toEqual([["characterData", "a"]])
    })
  })

  describe("options", () => {
    const target = new FakeElement("div")
    const bad: Array<[string, Parameters<MutationObserver["observe"]>[1]]> = [
      ["none", {}],
      ["only subtree", { subtree: true }],
      ["attributes false with attributeOldValue", { attributes: false, attributeOldValue: true }],
      ["attributes false with attributeFilter", { attributes: false, attributeFilter: ["a"] }],
      ["characterData false with characterDataOldValue", { characterData: false, characterDataOldValue: true }],
    ]
    for (const [name, options] of bad) {
      it(`throws a TypeError for ${name}`, () => {
        expect(() => observer(() => {}).observe(target, options)).toThrow(TypeError)
      })
    }

    it("throws a TypeError for a target that is not a Node and for missing options", () => {
      expect(() => observer(() => {}).observe({} as Node, { childList: true })).toThrow(TypeError)
      expect(() => observer(() => {}).observe(target)).toThrow(TypeError)
    })

    it("lets attributeOldValue and attributeFilter imply attributes, and characterDataOldValue characterData", () => {
      const element = new FakeElement("div", { a: "1" })
      const text = new FakeText("t")
      const mo = observer(() => {})
      expect(() => mo.observe(element, { attributeOldValue: true })).not.toThrow()
      expect(() => mo.observe(element, { attributeFilter: ["a"] })).not.toThrow()
      expect(() => mo.observe(text, { characterDataOldValue: true })).not.toThrow()
    })

    it("replaces the options when the same node is observed again", () => {
      const element = new FakeElement("div")
      const mo = observer(() => {})
      mo.observe(element, { childList: true })
      mo.observe(element, { attributes: true })
      append(element, new FakeElement("p"))
      expect(mo.takeRecords()).toHaveLength(0)
      setProp(element, "id", "a")
      expect(mo.takeRecords()).toHaveLength(1)
    })
  })

  describe("delivery", () => {
    it("batches every record of an observer into one callback, in creation order across observers", async () => {
      const element = new FakeElement("div")
      const order: string[] = []
      const first = observer((records) => order.push(`first:${records.length}`))
      const second = observer((records) => order.push(`second:${records.length}`))
      second.observe(element, { attributes: true })
      first.observe(element, { attributes: true })
      setProp(element, "a", "1")
      setProp(element, "b", "1")
      await Promise.resolve()
      expect(order).toEqual(["first:2", "second:2"])
    })

    it("takeRecords empties the queue, so nothing is delivered", async () => {
      const element = new FakeElement("div")
      const callback = vi.fn()
      const mo = observer(callback)
      mo.observe(element, { attributes: true })
      setProp(element, "a", "1")
      expect(mo.takeRecords()).toHaveLength(1)
      expect(mo.takeRecords()).toHaveLength(0)
      await Promise.resolve()
      expect(callback).not.toHaveBeenCalled()
    })

    it("disconnect drops queued records and stops observing", async () => {
      const element = new FakeElement("div")
      const callback = vi.fn()
      const mo = observer(callback)
      mo.observe(element, { attributes: true })
      setProp(element, "a", "1")
      mo.disconnect()
      setProp(element, "a", "2")
      await Promise.resolve()
      expect(callback).not.toHaveBeenCalled()
      expect(mo.takeRecords()).toHaveLength(0)
    })

    it("delivers records made inside a callback in a later microtask", async () => {
      const element = new FakeElement("div")
      const seen: number[] = []
      const mo = observer((records) => {
        seen.push(records.length)
        if (seen.length === 1) setProp(element, "b", "1")
      })
      mo.observe(element, { attributes: true })
      setProp(element, "a", "1")
      await Promise.resolve()
      expect(seen).toEqual([1])
      await Promise.resolve()
      expect(seen).toEqual([1, 1])
    })

    it("reports a throwing callback without stopping the others", async () => {
      const element = new FakeElement("div")
      const reported = vi.fn()
      vi.stubGlobal("reportError", reported)
      try {
        const bad = observer(() => {
          throw new Error("boom")
        })
        const good = vi.fn()
        bad.observe(element, { attributes: true })
        observer(good).observe(element, { attributes: true })
        setProp(element, "a", "1")
        await Promise.resolve()
        expect(reported).toHaveBeenCalledTimes(1)
        expect(good).toHaveBeenCalledTimes(1)
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  describe("a node removed from the observed subtree", () => {
    it("keeps reporting the removed subtree until the next delivery", async () => {
      const root = new FakeElement("div")
      const child = new FakeElement("div")
      append(root, child)
      const callback = vi.fn()
      observer(callback).observe(root, { attributes: true, childList: true, subtree: true })
      remove(child)
      setProp(child, "id", "x")
      await Promise.resolve()
      const records = callback.mock.calls[0][0] as MutationRecord[]
      expect(records.map((record) => record.type)).toEqual(["childList", "attributes"])
      setProp(child, "id", "y")
      expect(hasMutationObservers()).toBe(true)
      await Promise.resolve()
      expect(callback).toHaveBeenCalledTimes(1)
    })

    it("does not report a removed node that the observer does not watch the subtree of", () => {
      const root = new FakeElement("div")
      const child = new FakeElement("div")
      append(root, child)
      const mo = observer(() => {})
      mo.observe(root, { attributes: true, childList: true })
      remove(child)
      setProp(child, "id", "x")
      expect(mo.takeRecords().map((record) => record.type)).toEqual(["childList"])
    })
  })

  describe("when nothing is observed", () => {
    it("counts no registration, and an observer that was disconnected leaves none", () => {
      expect(hasMutationObservers()).toBe(false)
      const element = new FakeElement("div")
      const mo = observer(() => {})
      mo.observe(element, { childList: true, subtree: true })
      expect(hasMutationObservers()).toBe(true)
      remove(append0(element))
      mo.disconnect()
      expect(hasMutationObservers()).toBe(false)
    })

    it("makes no record and touches no node", () => {
      const element = new FakeElement("div")
      const binding = vi.spyOn(element, DOM_BINDING)
      queueChildListMutation(element, [], [], null, null)
      queueAttributeMutation(element, "a", null)
      queueCharacterDataMutation(new FakeText("t"), "t")
      setProp(element, "a", "1")
      expect(binding).not.toHaveBeenCalled()
      expect(hasMutationObservers()).toBe(false)
    })
  })

  describe("attribute names", () => {
    it("are the lowercase names of the props on an HTML element, and keep their case on SVG", () => {
      const html = new FakeElement("label", { tabIndex: 0, className: "a", htmlFor: "x", "data-rowId": "1" })
      expect(html.getAttributeNames()).toEqual(["tabindex", "class", "for", "data-rowid"])
      expect(html.hasAttribute("tabindex")).toBe(true)
      expect(html.hasAttribute("tabIndex")).toBe(true)
      expect(html.getAttribute("tabindex")).toBe("0")
      expect(html.getAttribute("tabIndex")).toBe("0")
      expect(html.getAttribute("FOR")).toBe("x")
      expect(html.getAttribute("htmlFor")).toBeNull()
      expect(html.getAttribute("className")).toBeNull()
      const svg = new FakeSvg("svg", { viewBox: "0 0 1 1", className: "s" })
      expect(svg.getAttributeNames()).toEqual(["viewBox", "class"])
      expect(svg.getAttribute("viewBox")).toBe("0 0 1 1")
      expect(svg.getAttribute("viewbox")).toBeNull()
    })

    it("name the attribute of a record, so an attributeFilter of the lowercase name matches", () => {
      const element = new FakeElement("div")
      const filtered = observer(() => {})
      filtered.observe(element, { attributeFilter: ["tabindex", "class"] })
      setProp(element, "tabIndex", 0)
      setProp(element, "className", "a")
      setProp(element, "htmlFor", "x")
      expect(filtered.takeRecords().map((record) => record.attributeName)).toEqual(["tabindex", "class"])
    })

    it("keep the case on an SVG element", () => {
      const svg = new FakeSvg("svg")
      const mo = observer(() => {})
      mo.observe(svg, { attributes: true })
      recordAttributeChanges(svg, ["viewBox"], () => {
        svg.props.viewBox = "0 0 1 1"
      })
      expect(mo.takeRecords().map((record) => record.attributeName)).toEqual(["viewBox"])
    })
  })

  describe("what an observer holds", () => {
    it("keeps observing a node that is still alive through a collection", async () => {
      const mo = observer(() => {})
      const tree = new FakeElement("div")
      mo.observe(tree, { childList: true, subtree: true })
      await collect()
      expect(hasMutationObservers()).toBe(true)
      remove(append0(tree))
      expect(mo.takeRecords()).toHaveLength(2)
    })

    it("does not keep an observed node alive, and the live count follows its collection", async () => {
      const mo = observer(() => {})
      let holder: WeakRef<FakeElement>
      ;(() => {
        const node = new FakeElement("div")
        holder = new WeakRef(node)
        mo.observe(node, { childList: true, subtree: true })
        append(node, new FakeElement("p"))
        mo.takeRecords()
      })()
      await collect()
      expect(holder!.deref()).toBeUndefined()
      expect(hasMutationObservers()).toBe(false)
      expect(() => mo.disconnect()).not.toThrow()
      expect(hasMutationObservers()).toBe(false)
    })

    it("counts a registration once when its node is collected after a disconnect", async () => {
      const mo = observer(() => {})
      const kept = new FakeElement("div")
      mo.observe(kept, { attributes: true })
      ;(() => {
        const node = new FakeElement("div")
        mo.observe(node, { attributes: true })
        mo.disconnect()
        mo.observe(kept, { attributes: true })
      })()
      await collect()
      expect(hasMutationObservers()).toBe(true)
      mo.disconnect()
      expect(hasMutationObservers()).toBe(false)
    })
  })
})

/** `gc` without `--expose-gc`: V8 takes the flag at runtime and a fresh context gets the function. */
v8.setFlagsFromString("--expose-gc")
const collectGarbage = vm.runInNewContext("gc") as () => void

async function collect(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    collectGarbage()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function append0(parent: FakeElement): FakeElement {
  const child = new FakeElement("i")
  append(parent, child)
  return child
}
