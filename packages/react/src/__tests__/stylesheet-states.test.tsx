/**
 * `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within` in a stylesheet compile into the
 * state blocks of the element (`hover`, `active`, `focus`, ...), so what they change shows while the
 * state holds and goes with it. `:popover-open` is tree state and applies while the popover is open.
 * Each state sets `width`, which the box reports.
 */
import React from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("state pseudo-classes in a stylesheet in React", () => {
  let app: TestRoot

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
    app.render(
      <div>
        <style>{`.btn { width: 100px; height: 30px } .btn:hover { width: 150px }`}</style>
        <div testId="btn" className="btn" />
      </div>
    )
    expect(widthOf("btn")).toBe(100)
    app.renderer.nativeSimulateMouseMove(...centre("btn"))
    expect(widthOf("btn")).toBe(150)
    app.renderer.nativeSimulateMouseMove(390, 290)
    expect(widthOf("btn")).toBe(100)
  })

  it("applies :active while the button is pressed", () => {
    app.render(
      <div>
        <style>{`.btn { width: 100px; height: 30px } .btn:active { width: 120px }`}</style>
        <div testId="btn" className="btn" />
      </div>
    )
    const [x, y] = centre("btn")
    app.renderer.nativeSimulateMouseMove(x, y)
    expect(widthOf("btn")).toBe(100)
    app.renderer.nativeSimulateMouseDown(x, y)
    expect(widthOf("btn")).toBe(120)
    app.renderer.nativeSimulateMouseUp(x, y)
    expect(widthOf("btn")).toBe(100)
  })

  it("applies :focus to the focused element and :focus-visible to one focused from the keyboard", () => {
    app.render(
      <div>
        <style>{`
          .field { width: 100px; height: 30px }
          .field:focus { width: 110px }
          .field:focus-visible { width: 130px }
        `}</style>
        <div testId="field" className="field" tabIndex={0} />
        <div testId="other" className="field" tabIndex={0} />
      </div>
    )
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
    app.render(
      <div>
        <style>{`
          .field { width: 100px; height: 30px; transition: width 1s linear }
          .field:focus { width: 110px }
          .field:focus-visible { width: 130px }
          .group { width: 100px; height: 60px; transition: width 1s linear }
          .group:focus-within { width: 160px }
        `}</style>
        <div testId="field" className="field" tabIndex={0} />
        <div testId="group" className="group">
          <input testId="inner" style={{ width: 40, height: 20 }} />
        </div>
      </div>
    )
    app.renderer.simulateKeystrokes("Tab")
    app.renderer.clockFastForward(500)
    expect(widthOf("field")).toBeGreaterThan(105)
    expect(widthOf("field")).toBeLessThan(125)
    app.renderer.clockFastForward(1000)
    expect(widthOf("field"), "focus-visible is above focus, as without a transition").toBe(130)

    app.renderer.focusElement(idOf("inner"))
    app.renderer.clockFastForward(500)
    expect(widthOf("group")).toBeGreaterThan(125)
    expect(widthOf("group")).toBeLessThan(135)
    app.renderer.clockFastForward(1000)
    expect(widthOf("group")).toBe(160)
  })

  it("applies :focus-within to an ancestor of the focused element", () => {
    app.render(
      <div>
        <style>{`.group { width: 100px; height: 60px } .group:focus-within { width: 160px }`}</style>
        <div testId="group" className="group">
          <input testId="field" style={{ width: 40, height: 20 }} />
        </div>
        <input testId="outside" style={{ width: 40, height: 20 }} />
      </div>
    )
    expect(widthOf("group")).toBe(100)
    app.renderer.focusElement(idOf("field"))
    expect(widthOf("group")).toBe(160)
    app.renderer.focusElement(idOf("outside"))
    expect(widthOf("group")).toBe(100)
  })

  it("lets an inline value beat a sheet :hover, and the hover keeps what the inline style leaves alone", () => {
    app.render(
      <div>
        <style>{`.btn { height: 30px } .btn:hover { width: 150px; height: 40px }`}</style>
        <div testId="btn" className="btn" style={{ width: 100 }} />
      </div>
    )
    app.renderer.nativeSimulateMouseMove(...centre("btn"))
    expect(widthOf("btn")).toBe(100)
    expect(app.renderer.getElementBounds(idOf("btn"))!.height).toBe(40)
  })

  it("lets a more specific base rule beat a :hover rule", () => {
    app.render(
      <div>
        <style>{`#btn { width: 100px; height: 30px } .btn:hover { width: 150px }`}</style>
        <div testId="btn" id="btn" className="btn" />
      </div>
    )
    app.renderer.nativeSimulateMouseMove(...centre("btn"))
    expect(widthOf("btn")).toBe(100)
  })

  it("drops a rule with a state it cannot compile, and keeps the siblings in an :is() list", () => {
    let also: HTMLElement | undefined
    app.render(
      <div>
        <style>{`
          :is(.keep, .card:hover .title) { width: 70px; height: 20px }
          .also, .card:hover .title { opacity: 0.5 }
        `}</style>
        <div testId="keep" className="keep" />
        <div ref={(element: unknown) => {
            also = element as HTMLElement
          }} className="also" />
      </div>
    )
    expect(widthOf("keep")).toBe(70)
    expect(getComputedStyle(also!).opacity).toBe("1")
  })

  it("applies :popover-open while a popover is shown", () => {
    let box: HTMLElement | undefined
    app.render(
      <div>
        <style>{`[popover]:popover-open { opacity: 0.5 } [popover] { padding-top: 4px }`}</style>
        <div ref={(element: unknown) => {
            box = element as HTMLElement
          }} popover="manual" />
      </div>
    )
    expect(getComputedStyle(box!).opacity).toBe("1")
    expect(getComputedStyle(box!).paddingTop).toBe("4px")
    box!.showPopover()
    expect(getComputedStyle(box!).opacity).toBe("0.5")
    box!.hidePopover()
    expect(getComputedStyle(box!).opacity).toBe("1")
    expect(getComputedStyle(box!).paddingTop).toBe("4px")
  })
})
