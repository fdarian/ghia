/** `setAttribute`, `removeAttribute` and `toggleAttribute` on a React host instance: the write has the effect of the prop. */
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type A11yTreeDump } from "../testing.js"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const box = { width: 40, height: 20 }

describeNative("attribute writes on a React host instance", () => {
  const roots: ReturnType<typeof createTestRoot>[] = []
  const observers: MutationObserver[] = []

  function setup(element: React.ReactElement) {
    const root = createTestRoot({ width: 300, height: 200 })
    roots.push(root)
    root.render(element)
    const renderer = root.renderer
    const idOf = (testId: string) => renderer.findByTestId(testId)!.id
    const focused = () => renderer.getElement(renderer.getFocusedElementId())?.testId ?? null
    const center = (testId: string): [number, number] => {
      const bounds = renderer.getElementBounds(idOf(testId))!
      return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
    }
    return { root, renderer, idOf, focused, center }
  }

  function ariaOf(tree: A11yTreeDump, label: string) {
    return Object.values(tree.nodes ?? {}).find((node) => node.aria?.label === label)?.aria
  }

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect()
    for (const root of roots.splice(0)) root.unmount()
  })

  it("round-trips set, remove and toggle through getAttribute, hasAttribute, getAttributeNames and dataset", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} testId="box" data-kept="1" style={box} />)
    const target = element!
    expect(target.hasAttribute("data-extra")).toBe(false)
    target.setAttribute("data-extra", "x")
    target.setAttribute("DATA-Other", "y")
    expect(target.getAttribute("data-extra")).toBe("x")
    expect(target.hasAttribute("data-extra")).toBe(true)
    expect(target.getAttributeNames().sort()).toEqual(["data-extra", "data-kept", "data-other", "style", "testid"].sort())
    expect(target.dataset).toEqual({ kept: "1", extra: "x", other: "y" })
    target.setAttribute("data-extra", 5 as unknown as string)
    expect(target.getAttribute("data-extra")).toBe("5")
    target.removeAttribute("data-extra")
    expect(target.getAttribute("data-extra")).toBeNull()
    expect(target.hasAttribute("data-extra")).toBe(false)
    target.removeAttribute("data-never-set")

    expect(target.toggleAttribute("data-flag")).toBe(true)
    expect(target.getAttribute("data-flag")).toBe("")
    expect(target.toggleAttribute("data-flag")).toBe(false)
    expect(target.hasAttribute("data-flag")).toBe(false)
    expect(target.toggleAttribute("data-flag", true)).toBe(true)
    expect(target.toggleAttribute("data-flag", true)).toBe(true)
    expect(target.toggleAttribute("data-flag", false)).toBe(false)
    expect(target.toggleAttribute("data-flag", false)).toBe(false)
  })

  it("reflects a typed prop as the browser does: tabindex as a number, a boolean attribute by presence", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={box} />)
    const target = element!
    target.setAttribute("tabindex", "-1")
    expect(target.getAttribute("tabindex")).toBe("-1")
    expect((target as unknown as { props: Record<string, unknown> }).props.tabIndex).toBe(-1)
    target.setAttribute("hidden", "any text")
    expect((target as unknown as { props: Record<string, unknown> }).props.hidden).toBe(true)
    expect(target.getAttribute("hidden")).toBe("")
    target.toggleAttribute("hidden")
    expect(target.hasAttribute("hidden")).toBe(false)
    target.setAttribute("class", "a b")
    expect(target.getAttribute("class")).toBe("a b")
    expect(target.className).toBe("a b")
  })

  it("throws InvalidCharacterError for a name the DOM rejects", () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} style={box} />)
    expect(() => element!.setAttribute("a b", "1")).toThrow(expect.objectContaining({ name: "InvalidCharacterError" }))
    expect(() => element!.setAttribute("", "1")).toThrow(expect.objectContaining({ name: "InvalidCharacterError" }))
  })

  it("keeps on* as text for getAttribute and sends nothing to native", () => {
    const clicks: string[] = []
    let element: PublicInstance | null = null
    const { renderer, center } = setup(
      <div ref={(instance) => (element = instance)} testId="box" style={box} onClick={() => clicks.push("prop")} />
    )
    element!.setAttribute("onclick", "alert(1)")
    expect(element!.getAttribute("onclick")).toBe("alert(1)")
    expect(element!.getAttributeNames()).toEqual(expect.arrayContaining(["onclick"]))
    renderer.nativeSimulateClick(...center("box"))
    expect(clicks).toEqual(["prop"])
    expect(element!.getAttribute("class")).toBeNull()
  })

  it("makes an element focusable with tabindex -1 and a tab stop with 0", () => {
    const targets: Record<string, PublicInstance | null> = { skipped: null, stop: null }
    const { renderer, focused, idOf } = setup(
      <div style={{ width: 200, height: 100 }}>
        <div testId="first" tabIndex={0} style={box} />
        <div ref={(instance) => (targets.skipped = instance)} testId="skipped" style={box} />
        <div ref={(instance) => (targets.stop = instance)} testId="stop" style={box} />
      </div>
    )
    renderer.focusElement(idOf("skipped"))
    expect(focused()).toBeNull()

    targets.skipped!.setAttribute("tabindex", "-1")
    renderer.focusElement(idOf("skipped"))
    expect(focused()).toBe("skipped")
    renderer.focusElement(idOf("first"))
    renderer.simulateKeystrokes("Tab")
    expect(focused()).toBe("first")

    targets.stop!.setAttribute("tabindex", "0")
    renderer.simulateKeystrokes("Tab")
    expect(focused()).toBe("stop")

    targets.stop!.setAttribute("tabindex", "-1")
    renderer.focusElement(idOf("first"))
    renderer.simulateKeystrokes("Tab")
    expect(focused()).toBe("first")
    targets.stop!.removeAttribute("tabindex")
    renderer.focusElement(idOf("stop"))
    expect(focused()).toBe("first")
  })

  it("hides an element from the accessibility tree with aria-hidden, and shows it again", () => {
    let element: PublicInstance | null = null
    const { renderer } = setup(
      <div ref={(instance) => (element = instance)} style={{ width: 120, height: 40 }}>
        <div role="button" aria-label="inside" style={box} />
      </div>
    )
    expect(ariaOf(renderer.getA11yTree(), "inside")?.hidden).toBeFalsy()
    element!.setAttribute("aria-hidden", "true")
    expect(ariaOf(renderer.getA11yTree(), "inside")?.hidden).toBe(true)
    element!.removeAttribute("aria-hidden")
    expect(ariaOf(renderer.getA11yTree(), "inside")?.hidden).toBeFalsy()
    element!.setAttribute("aria-hidden", "false")
    expect(ariaOf(renderer.getA11yTree(), "inside")?.hidden).toBeFalsy()
  })

  it("makes a subtree inert: no pointer, no focus, no accessibility node", () => {
    const clicks: string[] = []
    let region: PublicInstance | null = null
    const { renderer, idOf, focused, center } = setup(
      <div ref={(instance) => (region = instance)} style={{ width: 200, height: 100 }}>
        <div
          role="button"
          aria-label="inner"
          testId="inner"
          tabIndex={0}
          style={box}
          onClick={() => clicks.push("inner")}
        />
      </div>
    )
    renderer.nativeSimulateClick(...center("inner"))
    expect(clicks).toEqual(["inner"])
    renderer.focusElement(idOf("inner"))
    expect(focused()).toBe("inner")

    region!.setAttribute("inert", "")
    expect(focused()).toBeNull()
    renderer.focusElement(idOf("inner"))
    expect(focused()).toBeNull()
    renderer.nativeSimulateClick(...center("inner"))
    expect(clicks).toEqual(["inner"])
    expect(ariaOf(renderer.getA11yTree(), "inner")?.hidden).toBe(true)

    region!.removeAttribute("inert")
    renderer.nativeSimulateClick(...center("inner"))
    expect(clicks).toEqual(["inner", "inner"])
    renderer.focusElement(idOf("inner"))
    expect(focused()).toBe("inner")
  })

  it("lets a later commit of the same prop win, and leaves what the framework never set", () => {
    let element: PublicInstance | null = null
    const view = (label: string, other: number) => (
      <div
        ref={(instance) => (element = instance)}
        data-label={label}
        data-other={other}
        data-stays="a"
        style={box}
      />
    )
    const { root } = setup(view("one", 0))
    element!.setAttribute("data-label", "written")
    element!.setAttribute("data-other", "written")
    element!.setAttribute("data-added", "kept")
    element!.removeAttribute("data-stays")

    // A commit that leaves a prop as it was does not touch the attribute, as in React DOM.
    root.render(view("one", 1))
    expect(element!.getAttribute("data-label")).toBe("written")
    expect(element!.getAttribute("data-other")).toBe("1")
    expect(element!.getAttribute("data-added")).toBe("kept")
    expect(element!.getAttribute("data-stays")).toBeNull()

    root.render(view("two", 1))
    expect(element!.getAttribute("data-label")).toBe("two")
    expect(element!.getAttribute("data-added")).toBe("kept")
  })

  it("drops a set aria-hidden when the commit removes the prop", () => {
    let element: PublicInstance | null = null
    const view = (hidden: boolean) => (
      <div ref={(instance) => (element = instance)} aria-hidden={hidden ? "true" : undefined} style={{ width: 80, height: 30 }}>
        <div role="button" aria-label="inside" style={box} />
      </div>
    )
    const { root, renderer } = setup(view(false))
    element!.setAttribute("aria-hidden", "true")
    expect(ariaOf(renderer.getA11yTree(), "inside")?.hidden).toBe(true)
    root.render(view(true))
    root.render(view(false))
    expect(element!.hasAttribute("aria-hidden")).toBe(false)
    expect(ariaOf(renderer.getA11yTree(), "inside")?.hidden).toBeFalsy()
  })

  it("records attribute mutations with oldValue, for props and for style and on*", async () => {
    let element: PublicInstance | null = null
    setup(<div ref={(instance) => (element = instance)} data-a="1" style={box} />)
    const observer = new MutationObserver(() => {})
    observer.observe(element!, { attributes: true, attributeOldValue: true })
    observers.push(observer)
    element!.setAttribute("data-a", "2")
    element!.setAttribute("data-b", "x")
    element!.setAttribute("tabindex", "0")
    element!.setAttribute("style", "color: red")
    element!.removeAttribute("data-b")
    element!.toggleAttribute("inert")
    element!.removeAttribute("data-never-set")
    const records = observer.takeRecords()
    expect(records.map((record) => [record.type, record.attributeName, record.oldValue])).toEqual([
      ["attributes", "data-a", "1"],
      ["attributes", "data-b", null],
      ["attributes", "tabindex", null],
      ["attributes", "style", "width: 40px; height: 20px;"],
      ["attributes", "data-b", "x"],
      ["attributes", "inert", null],
    ])
    expect(records.every((record) => record.target === element)).toBe(true)
  })

  describe("with a stylesheet", () => {
    const sheet = `
      [data-state="open"] { opacity: 0.25 }
      .marked { padding-top: 7px }
      [hidden] { padding-left: 5px }
    `

    it("applies and un-applies a rule keyed on an attribute written by setAttribute", () => {
      let element: PublicInstance | null = null
      setup(
        <div>
          <style>{sheet}</style>
          <div ref={(instance) => (element = instance)} style={box} />
        </div>
      )
      const target = element!
      expect(getComputedStyle(target).opacity).toBe("1")
      target.setAttribute("data-state", "open")
      expect(getComputedStyle(target).opacity).toBe("0.25")
      target.setAttribute("data-state", "closed")
      expect(getComputedStyle(target).opacity).toBe("1")
      target.setAttribute("data-state", "open")
      target.removeAttribute("data-state")
      expect(getComputedStyle(target).opacity).toBe("1")

      target.setAttribute("class", "marked")
      expect(getComputedStyle(target).paddingTop).toBe("7px")
      target.removeAttribute("class")
      expect(getComputedStyle(target).paddingTop).toBe("0px")

      expect(target.toggleAttribute("hidden")).toBe(true)
      expect(getComputedStyle(target).paddingLeft).toBe("5px")
      expect(target.toggleAttribute("hidden")).toBe(false)
      expect(getComputedStyle(target).paddingLeft).toBe("0px")
    })

    it("applies and un-applies a rule keyed on a data attribute written through dataset", () => {
      let element: PublicInstance | null = null
      setup(
        <div>
          <style>{sheet}</style>
          <div ref={(instance) => (element = instance)} style={box} />
        </div>
      )
      const target = element!
      target.dataset.state = "open"
      expect(getComputedStyle(target).opacity).toBe("0.25")
      delete target.dataset.state
      expect(getComputedStyle(target).opacity).toBe("1")
    })

    it("sends an attribute written before the first sheet exists once one does", () => {
      let element: PublicInstance | null = null
      const view = (withSheet: boolean) => (
        <div>
          <div ref={(instance) => (element = instance)} style={box} />
          {withSheet && <style>{sheet}</style>}
        </div>
      )
      const { root } = setup(view(false))
      const target = element!
      target.setAttribute("data-state", "open")
      root.render(view(true))
      expect(element).toBe(target)
      expect(getComputedStyle(target).opacity).toBe("0.25")
    })
  })
})
