/**
 * `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within` in a stylesheet compile into the
 * state blocks of the element (`hover`, `active`, `focus`, ...), so what they change shows while the
 * state holds and goes with it. `:popover-open` is tree state and applies while the popover is open.
 * Each state sets `width`, which the box reports.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("state pseudo-classes in a stylesheet in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot({ width: 400, height: 300 })
  })

  afterEach(() => {
    app.unmount()
  })

  const idOf = (testId: string) => app.renderer.findByTestId(testId)!.id
  const widthOf = (testId: string): number => {
    app.renderer.dispatchNativeEvents()
    return app.renderer.getElementBounds(idOf(testId))!.width
  }
  const centre = (testId: string): [number, number] => {
    const bounds = app.renderer.getElementBounds(idOf(testId))!
    return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
  }

  it("applies :hover while the pointer is over the element and goes when it leaves", () => {
    app.render(() => (
      <div>
        <style>{`.btn { width: 100px; height: 30px } .btn:hover { width: 150px }`}</style>
        <div testId="btn" class="btn" />
      </div>
    ))
    expect(widthOf("btn")).toBe(100)
    app.renderer.nativeSimulateMouseMove(...centre("btn"))
    expect(widthOf("btn")).toBe(150)
    app.renderer.nativeSimulateMouseMove(390, 290)
    expect(widthOf("btn")).toBe(100)
  })

  it("applies :active while the button is pressed", () => {
    app.render(() => (
      <div>
        <style>{`.btn { width: 100px; height: 30px } .btn:active { width: 120px }`}</style>
        <div testId="btn" class="btn" />
      </div>
    ))
    const [x, y] = centre("btn")
    app.renderer.nativeSimulateMouseMove(x, y)
    expect(widthOf("btn")).toBe(100)
    app.renderer.nativeSimulateMouseDown(x, y)
    expect(widthOf("btn")).toBe(120)
    app.renderer.nativeSimulateMouseUp(x, y)
    expect(widthOf("btn")).toBe(100)
  })

  it("applies :focus to the focused element and :focus-visible to one focused from the keyboard", () => {
    app.render(() => (
      <div>
        <style>{`
          .field { width: 100px; height: 30px }
          .field:focus { width: 110px }
          .field:focus-visible { width: 130px }
        `}</style>
        <div testId="field" class="field" tabIndex={0} />
        <div testId="other" class="field" tabIndex={0} />
      </div>
    ))
    expect([widthOf("field"), widthOf("other")]).toEqual([100, 100])

    // Focused by a press: focused, not focus-visible.
    app.renderer.nativeSimulateClick(...centre("field"))
    expect([widthOf("field"), widthOf("other")]).toEqual([110, 100])

    app.renderer.simulateKeystrokes("Tab")
    expect([widthOf("field"), widthOf("other")]).toEqual([100, 130])
    app.renderer.blurElement(idOf("other"))
    expect(widthOf("other")).toBe(100)
  })

  it("transitions :focus-within, and :focus-visible beats :focus on an element that transitions", () => {
    app.renderer.clockPause()
    app.render(() => (
      <div>
        <style>{`
          .field { width: 100px; height: 30px; transition: width 1s linear }
          .field:focus { width: 110px }
          .field:focus-visible { width: 130px }
          .group { width: 100px; height: 60px; transition: width 1s linear }
          .group:focus-within { width: 160px }
        `}</style>
        <div testId="field" class="field" tabIndex={0} />
        <div testId="group" class="group">
          <input testId="inner" style={{ width: 40, height: 20 }} />
        </div>
      </div>
    ))
    app.renderer.simulateKeystrokes("Tab")
    app.renderer.clockFastForward(500)
    expect(widthOf("field")).toBeGreaterThan(105)
    expect(widthOf("field")).toBeLessThan(125)
    app.renderer.clockFastForward(1000)
    expect(widthOf("field"), "focus-visible is above focus, as without a transition").toBe(130)

    app.renderer.blurElement(idOf("field"))
    app.renderer.clockFastForward(500)
    expect(widthOf("field"), "back from :focus-visible").toBeGreaterThan(105)
    expect(widthOf("field")).toBeLessThan(125)
    app.renderer.clockFastForward(1000)
    expect(widthOf("field")).toBe(100)

    app.renderer.focusElement(idOf("inner"))
    app.renderer.clockFastForward(500)
    expect(widthOf("group")).toBeGreaterThan(125)
    expect(widthOf("group")).toBeLessThan(135)
    app.renderer.clockFastForward(1000)
    expect(widthOf("group")).toBe(160)

    app.renderer.blurElement(idOf("inner"))
    app.renderer.clockFastForward(500)
    expect(widthOf("group"), "back from :focus-within").toBeGreaterThan(125)
    expect(widthOf("group")).toBeLessThan(135)
    app.renderer.clockFastForward(1000)
    expect(widthOf("group")).toBe(100)
  })

  it("hands what :focus-within sets to the children, with a transition on the element and without", () => {
    app.renderer.clockPause()
    app.render(() => (
      <div>
        <style>{`
          .card { font-size: 10px; width: 100px; height: 60px }
          .card:focus-within { font-size: 20px }
          .moving { transition: width 1s linear }
        `}</style>
        <div testId="plain" class="card">
          <input testId="plain-input" style={{ width: 40, height: 20 }} />
          <div testId="plain-child" style={{ width: "5em", height: 10 }} />
        </div>
        <div testId="moving" class="card moving">
          <input testId="moving-input" style={{ width: 40, height: 20 }} />
          <div testId="moving-child" style={{ width: "5em", height: 10 }} />
        </div>
      </div>
    ))
    const childWidth = (testId: string) => {
      app.renderer.dispatchNativeEvents()
      return app.renderer.getElementBounds(idOf(testId))!.width
    }
    expect([childWidth("plain-child"), childWidth("moving-child")]).toEqual([50, 50])
    for (const card of ["plain", "moving"]) {
      app.renderer.focusElement(idOf(`${card}-input`))
      app.renderer.clockFastForward(16)
      expect(childWidth(`${card}-child`), card).toBe(100)
      app.renderer.blurElement(idOf(`${card}-input`))
      app.renderer.clockFastForward(16)
      expect(childWidth(`${card}-child`), card).toBe(50)
    }
  })

  it("applies :focus-within to an ancestor of the focused element", () => {
    app.render(() => (
      <div>
        <style>{`.group { width: 100px; height: 60px } .group:focus-within { width: 160px }`}</style>
        <div testId="group" class="group">
          <input testId="field" style={{ width: 40, height: 20 }} />
        </div>
        <input testId="outside" style={{ width: 40, height: 20 }} />
      </div>
    ))
    expect(widthOf("group")).toBe(100)
    app.renderer.focusElement(idOf("field"))
    expect(widthOf("group")).toBe(160)
    app.renderer.focusElement(idOf("outside"))
    expect(widthOf("group")).toBe(100)
  })

  it("lets an inline value beat a sheet :hover, and the hover keeps what the inline style leaves alone", () => {
    app.render(() => (
      <div>
        <style>{`.btn { height: 30px } .btn:hover { width: 150px; height: 40px }`}</style>
        <div testId="btn" class="btn" style={{ width: 100 }} />
      </div>
    ))
    app.renderer.nativeSimulateMouseMove(...centre("btn"))
    expect(widthOf("btn")).toBe(100)
    expect(app.renderer.getElementBounds(idOf("btn"))!.height).toBe(40)
  })

  it("keeps an inline side border over a sheet :hover border-width, and an inline border-width over a :hover side", () => {
    app.render(() => (
      <div>
        <style>{`
          .sides:hover { border-width: 5px; border-style: solid }
          .all:hover { border-left: 6px solid blue }
        `}</style>
        <div testId="sides" class="sides" style={{ width: 100, height: 30, borderLeft: "2px solid red" }}>
          <div testId="sides-inner" style={{ width: "100%", height: 10 }} />
        </div>
        <div testId="all" class="all" style={{ width: 100, height: 30, borderWidth: 2, borderStyle: "solid" }}>
          <div testId="all-inner" style={{ width: "100%", height: 10 }} />
        </div>
      </div>
    ))
    // The borders are inside the width, so what they leave is the width of what the box holds.
    expect([widthOf("sides-inner"), widthOf("all-inner")]).toEqual([98, 96])
    app.renderer.nativeSimulateMouseMove(...centre("sides"))
    expect(widthOf("sides-inner"), "the left stays 2, the right is 5").toBe(93)
    app.renderer.nativeSimulateMouseMove(...centre("all"))
    expect(widthOf("all-inner"), "the inline border-width beats the left of the rule").toBe(96)
  })

  it("lets an inline !important value beat the inline hover block, whether or not a sheet matches the element", () => {
    app.render(() => (
      <div>
        <style>{`.matched { height: 30px }`}</style>
        <div testId="bare" style={{ width: "100px !important", height: 30, hover: { width: 150 } }} />
        <div testId="matched" class="matched" style={{ width: "100px !important", hover: { width: 150 } }} />
      </div>
    ))
    for (const testId of ["bare", "matched"]) {
      app.renderer.nativeSimulateMouseMove(...centre(testId))
      expect(widthOf(testId), testId).toBe(100)
    }
  })

  it("lets a more specific base rule beat a :hover rule", () => {
    app.render(() => (
      <div>
        <style>{`#btn { width: 100px; height: 30px } .btn:hover { width: 150px }`}</style>
        <div testId="btn" id="btn" class="btn" />
      </div>
    ))
    app.renderer.nativeSimulateMouseMove(...centre("btn"))
    expect(widthOf("btn")).toBe(100)
  })

  it("drops a rule with a state it cannot compile, and keeps the siblings in an :is() list", () => {
    let also: HTMLElement | undefined
    app.render(() => (
      <div>
        <style>{`
          :is(.keep, .card:hover .title) { width: 70px; height: 20px }
          .also, .card:hover .title { opacity: 0.5 }
        `}</style>
        <div testId="keep" class="keep" />
        <div ref={(element: unknown) => (also = element as HTMLElement)} class="also" />
      </div>
    ))
    expect(widthOf("keep")).toBe(70)
    expect(getComputedStyle(also!).opacity).toBe("1")
  })

  it("applies :popover-open while a popover is shown", () => {
    let box: HTMLElement | undefined
    app.render(() => (
      <div>
        <style>{`[popover]:popover-open { opacity: 0.5 } [popover] { padding-top: 4px }`}</style>
        <div ref={(element: unknown) => (box = element as HTMLElement)} popover="manual" />
      </div>
    ))
    expect(getComputedStyle(box!).opacity).toBe("1")
    expect(getComputedStyle(box!).paddingTop).toBe("4px")
    box!.showPopover()
    expect(getComputedStyle(box!).opacity).toBe("0.5")
    box!.hidePopover()
    expect(getComputedStyle(box!).opacity).toBe("1")
    expect(getComputedStyle(box!).paddingTop).toBe("4px")
  })
})
