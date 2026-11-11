// Selector queries on real Solid elements: `matches`, `closest`, `querySelector(All)` on an element and on
// `document`, the state pseudo-classes after a real focus, and the tabbable selector Base UI asks on every focus change.
import { describe, expect, it } from "vitest"
import { createSignal, Show } from "solid-js"
import { document } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { HostElement } from "../host.js"

const TABBABLE =
  "input:not([type='hidden']):not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],button:not([disabled]),[tabindex],iframe,object,embed,area[href],audio[controls],video[controls],[contenteditable]:not([contenteditable='false'])"

const box = { width: 80, height: 20 }
const ids = (list: Iterable<{ id: string }>) => [...list].map((element) => element.id)

function mount(view: () => any) {
  const app = createTestRoot({ width: 400, height: 300 })
  app.render(view)
  return app
}

describe.skipIf(!hasNativeTestRenderer)("selector queries on a Solid element", () => {
  it("finds, matches and walks up by selector", () => {
    const app = mount(() => (
      <div id="root" style={{ width: 300, height: 200 }}>
        <section id="s1" class="box" style={box}>
          <p id="p1" class="box inner" style={box}>a</p>
          <p id="p2" style={box}>b</p>
        </section>
        <section id="s2" style={box}>
          <p id="p3" class="inner" style={box}>c</p>
        </section>
      </div>
    ))
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
    app.unmount()
  })

  it("answers the state pseudo-classes for the element a real focus moved to", () => {
    let first!: HostElement
    let second!: HostElement
    const app = mount(() => (
      <div id="root" style={{ width: 300, height: 100 }}>
        <div id="group" style={box}>
          <div id="a" ref={first} tabIndex={0} style={box} />
        </div>
        <div id="b" ref={second} tabIndex={0} style={box} />
      </div>
    ))
    const group = document.querySelector("#group")!
    expect(first.matches(":focus")).toBe(false)
    first.focus()
    expect(first.matches(":focus")).toBe(true)
    expect(first.matches(":focus-visible")).toBe(true)
    expect(group.matches(":focus-within")).toBe(true)
    expect(second.matches(":focus")).toBe(false)
    expect(ids(document.querySelectorAll(":focus"))).toEqual(["a"])
    expect(ids(document.querySelectorAll("[tabindex]:not(:focus)"))).toEqual(["b"])
    second.focus()
    expect(first.matches(":focus")).toBe(false)
    expect(second.matches(":focus")).toBe(true)
    expect(group.matches(":focus-within")).toBe(false)
    app.unmount()
  })

  it("finds what a focus trap can tab to, in order", () => {
    const app = mount(() => (
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
    ))
    expect(ids(document.querySelector("#dialog")!.querySelectorAll(TABBABLE))).toEqual(["close", "name", "link", "stop"])
    app.unmount()
  })

  it("lets document find elements of the app below body, and sees them come and go", () => {
    const [shown, setShown] = createSignal(false)
    const app = mount(() => (
      <>
        <div id="app" class="layer" style={box} />
        <Show when={shown()}>
          <div id="popup" class="layer" style={box}>
            <button id="floating" style={box} />
          </div>
        </Show>
      </>
    ))
    expect(ids(document.querySelectorAll(".layer"))).toEqual(["app"])
    setShown(true)
    expect(ids(document.querySelectorAll(".layer"))).toEqual(["app", "popup"])
    expect(document.querySelector("body > #popup #floating")!.tagName).toBe("BUTTON")
    expect(document.querySelector("#popup")!.closest("body")).toBe(document.body)
    expect(document.querySelector(":root")).toBe(document.documentElement)
    setShown(false)
    expect(document.querySelector("#popup")).toBeNull()
    app.unmount()
  })

  it("queries the tabbable selector over a 1000-element tree", () => {
    const app = mount(() => (
      <div id="list" style={{ width: 300, height: 1000 }}>
        {Array.from({ length: 250 }, (_, index) => (
          <div class="row" style={{ width: 300, height: 4 }}>
            <button disabled={index % 5 === 0} style={{ width: 20, height: 4 }} />
            <input type={index % 7 === 0 ? "hidden" : "text"} style={{ width: 20, height: 4 }} />
            <a href={index % 2 === 0 ? "/" : undefined} style={{ width: 20, height: 4 }} />
          </div>
        ))}
      </div>
    ))
    const list = document.querySelector("#list")!
    expect(list.querySelectorAll("*").length).toBe(1000)
    list.querySelectorAll(TABBABLE)
    const rounds = 20
    const start = performance.now()
    let count = 0
    for (let round = 0; round < rounds; round += 1) count = list.querySelectorAll(TABBABLE).length
    console.log(`Solid: querySelectorAll(tabbable) over 1000 elements: ${((performance.now() - start) / rounds).toFixed(3)} ms (${count} found)`)
    expect(count).toBeGreaterThan(0)
    app.unmount()
  })
})
