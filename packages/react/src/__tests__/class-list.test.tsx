/** `element.classList`: a live `DOMTokenList` of the `class` attribute, on mounted, created and stand-in elements. */
// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest"
import { document, getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const box = { width: 40, height: 20 }

describeNative("classList in React", () => {
  const roots = []

  function mount(element) {
    const root = createTestRoot({ width: 300, height: 200 })
    roots.push(root)
    root.render(element)
    return root
  }

  afterEach(() => {
    for (const root of roots.splice(0)) root.unmount()
  })

  it("adds, removes, toggles and replaces tokens, and reads them back", () => {
    let element
    mount(<div ref={(instance) => (element = instance)} className="a  b" style={box} />)
    const list = element.classList
    expect(element.classList).toBe(list)
    expect(list.length).toBe(2)
    expect(list.value).toBe("a  b")
    expect(String(list)).toBe("a  b")
    expect([list.item(0), list.item(1), list.item(2), list[1], 0 in list, 2 in list]).toEqual(["a", "b", null, "b", true, false])
    expect(list.contains("a")).toBe(true)

    list.add("c", "a")
    expect(element.getAttribute("class")).toBe("a b c")
    expect(element.className).toBe("a b c")
    list.remove("b", "missing")
    expect(element.getAttribute("class")).toBe("a c")
    expect(list.toggle("d")).toBe(true)
    expect(list.toggle("d")).toBe(false)
    expect(list.toggle("e", true)).toBe(true)
    expect(list.toggle("e", true)).toBe(true)
    expect(list.toggle("a", false)).toBe(false)
    expect(list.toggle("f", false)).toBe(false)
    expect(element.getAttribute("class")).toBe("c e")
    expect(list.replace("c", "x")).toBe(true)
    expect(list.replace("nope", "y")).toBe(false)
    expect(element.getAttribute("class")).toBe("x e")
    expect(list.replace("e", "x")).toBe(true)
    expect(element.getAttribute("class")).toBe("x")

    expect([...list]).toEqual(["x"])
    expect([...list.entries()]).toEqual([[0, "x"]])
    const seen = []
    list.forEach((token, index) => seen.push([token, index]))
    expect(seen).toEqual([["x", 0]])

    list.value = "p q"
    expect(element.getAttribute("class")).toBe("p q")
    element.classList = "r"
    expect(element.getAttribute("class")).toBe("r")
    element.setAttribute("class", "s t")
    expect([...list]).toEqual(["s", "t"])
  })

  it("throws the DOM's errors for a bad token and for supports()", () => {
    let element
    mount(<div ref={(instance) => (element = instance)} style={box} />)
    const list = element.classList
    expect(() => list.add("")).toThrow(expect.objectContaining({ name: "SyntaxError" }))
    expect(() => list.remove("a b")).toThrow(expect.objectContaining({ name: "InvalidCharacterError" }))
    expect(() => list.toggle("")).toThrow(expect.objectContaining({ name: "SyntaxError" }))
    expect(() => list.replace("a", "")).toThrow(expect.objectContaining({ name: "SyntaxError" }))
    expect(() => list.supports("x")).toThrow(TypeError)
    expect(element.hasAttribute("class")).toBe(false)
  })

  it("does not make a class attribute out of an empty removal", () => {
    let element
    mount(<div ref={(instance) => (element = instance)} style={box} />)
    element.classList.remove("a")
    expect(element.hasAttribute("class")).toBe(false)
    element.classList.add("a")
    element.classList.remove("a")
    expect(element.getAttribute("class")).toBe("")
  })

  it("is the attribute path: a stylesheet and a MutationObserver see it", async () => {
    let element
    const root = mount(
      <div>
        <style>{".marked { padding-top: 7px }"}</style>
        <div ref={(instance) => (element = instance)} style={box} />
      </div>
    )
    const records = []
    const observer = new MutationObserver((list) => list.forEach((record) => records.push([record.attributeName, record.oldValue])))
    observer.observe(element, { attributes: true, attributeOldValue: true })
    expect(getComputedStyle(element).paddingTop).toBe("0px")
    element.classList.add("marked")
    expect(getComputedStyle(element).paddingTop).toBe("7px")
    element.classList.toggle("marked")
    expect(getComputedStyle(element).paddingTop).toBe("0px")
    await Promise.resolve()
    expect(records).toEqual([["class", null], ["class", "marked"]])
    observer.disconnect()
    root.renderer.flush()
  })

  it("works on an element made by code and on the stand-in html before a root", () => {
    const standIn = document.documentElement
    standIn.classList.add("dark")
    expect(standIn.classList.contains("dark")).toBe(true)
    const root = mount(<div style={box} />)
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    const made = document.createElement("div")
    made.classList.add("x", "y")
    expect(made.getAttribute("class")).toBe("x y")
    document.body.appendChild(made)
    expect(made.getAttribute("class")).toBe("x y")
    made.classList.remove("x")
    expect(made.className).toBe("y")
    root.renderer.flush()
  })
})
