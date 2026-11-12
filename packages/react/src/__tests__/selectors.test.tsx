// Selector queries on real host instances: `matches`, `closest`, `querySelector(All)` on an element and on
// `document`, the state pseudo-classes after a real focus, and the tabbable selector Base UI asks on every focus change.
import { describe, expect, it } from "vitest"
import { document, type PublicInstance } from "@ghia/native/host"
import { createPortal } from "../reconciler/portal.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const TABBABLE =
  "input:not([type='hidden']):not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],button:not([disabled]),[tabindex],iframe,object,embed,area[href],audio[controls],video[controls],[contenteditable]:not([contenteditable='false'])"

const box = { width: 80, height: 20 }
const ids = (list: Iterable<{ id: string }>) => [...list].map((element) => element.id)

describeNative("selector queries on a React host instance", () => {
  function mount(content: React.ReactElement) {
    const root = createTestRoot({ width: 400, height: 300 })
    root.render(content)
    return root
  }

  const page = (
    <div id="root" style={{ width: 300, height: 200 }}>
      <section id="s1" className="box" style={box}>
        <p id="p1" className="box inner" style={box}>a</p>
        <p id="p2" style={box}>b</p>
      </section>
      <section id="s2" style={box}>
        <p id="p3" className="inner" style={box}>c</p>
      </section>
    </div>
  )

  it("finds, matches and walks up by selector", () => {
    const root = mount(page)
    const top = document.querySelector("#root")!
    expect(ids(top.querySelectorAll("p"))).toEqual(["p1", "p2", "p3"])
    expect(ids(top.querySelectorAll("section > p.inner"))).toEqual(["p1", "p3"])
    expect(ids(top.querySelectorAll("p:not(.box)"))).toEqual(["p2", "p3"])
    expect(top.querySelector(".box")!.id).toBe("s1")
    expect(top.querySelector("table")).toBeNull()
    const p2 = top.querySelector("#p2")!
    expect(p2.matches("section > p:last-child")).toBe(true)
    expect(p2.closest(".box")!.id).toBe("s1")
    expect(p2.closest("p")).toBe(p2)
    expect(ids(top.querySelector("#s1")!.querySelectorAll(":scope > p"))).toEqual(["p1", "p2"])
    expect(() => top.querySelectorAll("p >")).toThrow(expect.objectContaining({ name: "SyntaxError" }))
    expect(top.querySelectorAll("p").item(1)!.id).toBe("p2")
    root.unmount()
  })

  it("answers the state pseudo-classes for the element a real focus moved to", () => {
    let first: PublicInstance | null = null
    let second: PublicInstance | null = null
    const root = mount(
      <div id="root" style={{ width: 300, height: 100 }}>
        <div id="group" style={box}>
          <div id="a" ref={(instance) => (first = instance)} tabIndex={0} style={box} />
        </div>
        <div id="b" ref={(instance) => (second = instance)} tabIndex={0} style={box} />
      </div>
    )
    const group = document.querySelector("#group")!
    expect(first!.matches(":focus")).toBe(false)
    first!.focus()
    expect(first!.matches(":focus")).toBe(true)
    expect(first!.matches(":focus-visible")).toBe(true)
    expect(group.matches(":focus-within")).toBe(true)
    expect(second!.matches(":focus")).toBe(false)
    expect(ids(document.querySelectorAll(":focus"))).toEqual(["a"])
    expect(ids(document.querySelectorAll("[tabindex]:not(:focus)"))).toEqual(["b"])
    expect(first!.closest(":focus-within")).toBe(first)
    second!.focus()
    expect(first!.matches(":focus")).toBe(false)
    expect(second!.matches(":focus")).toBe(true)
    expect(group.matches(":focus-within")).toBe(false)
    root.unmount()
  })

  it("finds what a focus trap can tab to, in order", () => {
    const root = mount(
      <div id="dialog" style={{ width: 300, height: 200 }}>
        <button id="close" style={box} />
        <input id="hidden" type="hidden" />
        <input id="name" type="text" style={box} />
        <input id="locked" disabled style={box} />
        <a id="plain" style={box} />
        <a id="link" href="/" style={box} />
        <div id="stop" tabIndex={-1} style={box} />
        <button id="off" disabled style={box} />
      </div>
    )
    expect(ids(document.querySelector("#dialog")!.querySelectorAll(TABBABLE))).toEqual(["close", "name", "link", "stop"])
    root.unmount()
  })

  it("lets document find an element in the app and one portalled into body", () => {
    function App() {
      return (
        <>
          <div id="app" className="layer" style={box}>
            <button id="inside" style={box} />
          </div>
          {createPortal(
            <div id="popup" className="layer" style={box}>
              <button id="floating" style={box} />
            </div>,
            document.body as unknown as PublicInstance
          )}
        </>
      )
    }
    const root = mount(<App />)
    expect(document.querySelector("#inside")!.tagName).toBe("BUTTON")
    expect(document.querySelector("#floating")!.parentElement!.id).toBe("popup")
    expect(ids(document.querySelectorAll(".layer"))).toEqual(ids(document.body!.children))
    expect(ids(document.querySelectorAll(".layer")).sort()).toEqual(["app", "popup"])
    expect(document.querySelector("body > #popup")).not.toBeNull()
    expect(document.querySelector("#popup")!.closest("body")).toBe(document.body)
    expect(document.querySelector("#nothing")).toBeNull()
    root.unmount()
  })

  it("sees the tree after a render changed it", () => {
    const root = mount(<div id="root" style={{ width: 100, height: 100 }}><p id="x" className="on" style={box} /></div>)
    const top = document.querySelector("#root")!
    expect(ids(top.querySelectorAll(".on"))).toEqual(["x"])
    root.render(<div id="root" style={{ width: 100, height: 100 }}><p id="x" style={box} /><p id="y" className="on" style={box} /></div>)
    expect(ids(top.querySelectorAll(".on"))).toEqual(["y"])
    root.unmount()
  })

  it("queries the tabbable selector over a 1000-element tree", () => {
    const rows = Array.from({ length: 250 }, (_, index) => (
      <div key={index} className="row" style={{ width: 300, height: 4 }}>
        <button disabled={index % 5 === 0} style={{ width: 20, height: 4 }} />
        <input type={index % 7 === 0 ? "hidden" : "text"} style={{ width: 20, height: 4 }} />
        <a {...(index % 2 === 0 ? { href: "/" } : {})} style={{ width: 20, height: 4 }} />
      </div>
    ))
    const root = mount(<div id="list" style={{ width: 300, height: 1000 }}>{rows}</div>)
    const list = document.querySelector("#list")!
    expect(list.querySelectorAll("*").length).toBe(1000)
    list.querySelectorAll(TABBABLE)
    const rounds = 20
    const start = performance.now()
    let count = 0
    for (let round = 0; round < rounds; round += 1) count = list.querySelectorAll(TABBABLE).length
    console.log(`React: querySelectorAll(tabbable) over 1000 elements: ${((performance.now() - start) / rounds).toFixed(3)} ms (${count} found)`)
    expect(count).toBeGreaterThan(0)
    root.unmount()
  })
})
