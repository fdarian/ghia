/**
 * The HTML popover API on elements React renders: a closed popover has no box, an open one is a
 * `position: fixed` box centred in the window and drawn above everything, `beforetoggle` and
 * `toggle` fire as in a browser, and `auto` closes on Escape and on a press outside.
 */
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document, getComputedStyle, ToggleEvent } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const WINDOW = { width: 800, height: 600 }

type Popover = HTMLElement & { popover: string | null }

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describeNative("popover in React", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot(WINDOW)
  })

  afterEach(() => {
    app.unmount()
  })

  /** Renders `tree` and collects the elements it gives its `ref`s by name. */
  function mount(tree: (grab: (name: string) => (instance: unknown) => void) => ReactNode): Record<string, Popover> {
    const found: Record<string, Popover> = {}
    const grab = (name: string) => (instance: unknown) => {
      if (instance !== null) found[name] = instance as Popover
    }
    app.render(tree(grab))
    return found
  }

  const popoverStyle = { width: 100, height: 50 }

  it("has no box while it is closed, and reflects its attribute", () => {
    const found = mount((grab) => (
      <div>
        <div ref={grab("box")} popover="manual">
          <div style={popoverStyle} />
        </div>
      </div>
    ))
    const rect = found.box.getBoundingClientRect()
    expect([rect.width, rect.height]).toEqual([0, 0])
    expect(found.box.offsetWidth).toBe(0)
    expect(found.box.getAttribute("popover")).toBe("manual")
    expect(found.box.popover).toBe("manual")
    expect(getComputedStyle(found.box).display).toBe("none")
  })

  it("gets a box in the top layer with the user agent style when it is shown", () => {
    const found = mount((grab) => (
      <div>
        <div ref={grab("box")} popover="manual">
          <div style={popoverStyle} />
        </div>
      </div>
    ))
    found.box.showPopover()
    const computed = getComputedStyle(found.box)
    expect(computed.position).toBe("fixed")
    const rect = found.box.getBoundingClientRect()
    // 100x50 content, 0.25em (4px) of padding and a 3px border on each side.
    expect([rect.width, rect.height]).toEqual([114, 64])
    expect(rect.left).toBeCloseTo((WINDOW.width - 114) / 2, 0)
    expect(rect.top).toBeCloseTo((WINDOW.height - 64) / 2, 0)
  })

  it("is above a later sibling with a z-index, an anchored layer, and escapes a clipping ancestor", () => {
    const found = mount((grab) => (
      <div style={{ width: WINDOW.width, height: WINDOW.height }}>
        <div style={{ width: 30, height: 30, overflow: "hidden" }}>
          <div ref={grab("box")} popover="manual">
            <div ref={grab("inner")} style={popoverStyle} />
          </div>
        </div>
        <div
          ref={grab("cover")}
          style={{ position: "absolute", left: 0, top: 0, width: WINDOW.width, height: WINDOW.height, zIndex: 10 }}
        />
        <anchored position={{ x: 0, y: 0 }} anchor="topLeft" deferred priority={1}>
          <div ref={grab("layer")} style={{ width: WINDOW.width, height: WINDOW.height }} />
        </anchored>
      </div>
    ))
    const centre = [WINDOW.width / 2, WINDOW.height / 2] as const
    expect(document.elementFromPoint(...centre)).toBe(found.layer)
    found.box.showPopover()
    expect(document.elementFromPoint(...centre)).toBe(found.inner)
    expect(document.elementsFromPoint(...centre).slice(0, 2)).toEqual([found.inner, found.box])
    found.box.hidePopover()
    expect(document.elementFromPoint(...centre)).toBe(found.layer)
  })

  it("puts the popover shown last on top", () => {
    const found = mount((grab) => (
      <div>
        <div ref={grab("first")} popover="manual">
          <div ref={grab("firstInner")} style={popoverStyle} />
        </div>
        <div ref={grab("second")} popover="manual">
          <div ref={grab("secondInner")} style={popoverStyle} />
        </div>
      </div>
    ))
    const centre = [WINDOW.width / 2, WINDOW.height / 2] as const
    found.second.showPopover()
    found.first.showPopover()
    expect(document.elementFromPoint(...centre)).toBe(found.firstInner)
    found.first.hidePopover()
    found.first.showPopover()
    found.second.hidePopover()
    found.second.showPopover()
    expect(document.elementFromPoint(...centre)).toBe(found.secondInner)
  })

  it("does not open when beforetoggle is cancelled, and says what it changes", async () => {
    const found = mount((grab) => (
      <div ref={grab("box")} popover="manual">
        <div style={popoverStyle} />
      </div>
    ))
    const seen: Array<[string, string, string, boolean]> = []
    found.box.addEventListener("beforetoggle", (event) => {
      const toggle = event as unknown as ToggleEvent
      seen.push([toggle.type, toggle.oldState, toggle.newState, toggle.cancelable])
      toggle.preventDefault()
    })
    found.box.showPopover()
    expect(seen).toEqual([["beforetoggle", "closed", "open", true]])
    expect(found.box.offsetWidth).toBe(0)
    expect(found.box.togglePopover()).toBe(false)
  })

  it("fires toggle once, queued, with the states of the change", async () => {
    const found = mount((grab) => (
      <div ref={grab("box")} popover="manual">
        <div style={popoverStyle} />
      </div>
    ))
    const seen: string[] = []
    found.box.addEventListener("beforetoggle", (event) => {
      const toggle = event as unknown as ToggleEvent
      seen.push(`before ${toggle.oldState}>${toggle.newState} ${toggle.cancelable}`)
    })
    found.box.addEventListener("toggle", (event) => {
      const toggle = event as unknown as ToggleEvent
      expect(toggle).toBeInstanceOf(ToggleEvent)
      expect(toggle.target).toBe(found.box)
      seen.push(`toggle ${toggle.oldState}>${toggle.newState} ${toggle.cancelable}`)
    })
    found.box.showPopover()
    found.box.showPopover()
    expect(seen).toEqual(["before closed>open true"])
    await nextTask()
    expect(seen).toEqual(["before closed>open true", "toggle closed>open false"])
    found.box.hidePopover()
    found.box.hidePopover()
    await nextTask()
    expect(seen.slice(2)).toEqual(["before open>closed false", "toggle open>closed false"])
  })

  it("coalesces the toggle events of changes made in one task", async () => {
    const found = mount((grab) => (
      <div ref={grab("box")} popover="manual">
        <div style={popoverStyle} />
      </div>
    ))
    const seen: string[] = []
    found.box.addEventListener("toggle", (event) => {
      const toggle = event as unknown as ToggleEvent
      seen.push(`${toggle.oldState}>${toggle.newState}`)
    })
    found.box.showPopover()
    found.box.hidePopover()
    found.box.showPopover()
    await nextTask()
    expect(seen).toEqual(["closed>open"])
  })

  it("hides, and togglePopover shows and hides and takes a force", () => {
    const found = mount((grab) => (
      <div ref={grab("box")} popover="manual">
        <div style={popoverStyle} />
      </div>
    ))
    expect(found.box.togglePopover()).toBe(true)
    expect(found.box.offsetWidth).toBe(114)
    expect(found.box.togglePopover(true)).toBe(true)
    expect(found.box.togglePopover()).toBe(false)
    expect(found.box.offsetWidth).toBe(0)
    expect(found.box.togglePopover(false)).toBe(false)
    expect(found.box.togglePopover(true)).toBe(true)
    found.box.hidePopover()
    expect(found.box.offsetWidth).toBe(0)
  })

  it("throws for an element with no popover attribute and for one that is not in the document", () => {
    const found = mount((grab) => (
      <div>
        <div ref={grab("plain")} />
        <div ref={grab("box")} popover="manual" />
      </div>
    ))
    expect(() => found.plain.showPopover()).toThrow(expect.objectContaining({ name: "NotSupportedError" }))
    expect(() => found.plain.hidePopover()).toThrow(expect.objectContaining({ name: "NotSupportedError" }))
    expect(() => found.plain.togglePopover()).toThrow(expect.objectContaining({ name: "NotSupportedError" }))
    const loose = document.createElement("div") as unknown as Popover
    loose.popover = "manual"
    expect(() => loose.showPopover()).toThrow(expect.objectContaining({ name: "InvalidStateError" }))
    loose.hidePopover()
  })

  it("closes an auto popover on Escape, and a manual one does not", () => {
    const found = mount((grab) => (
      <div>
        <div ref={grab("auto")} popover="auto">
          <div style={popoverStyle} />
        </div>
        <div ref={grab("manual")} popover="manual">
          <div style={popoverStyle} />
        </div>
      </div>
    ))
    found.manual.showPopover()
    app.renderer.simulateKeystrokes("Escape")
    expect(found.manual.offsetWidth, "manual ignores Escape").toBe(114)
    found.auto.showPopover()
    expect(found.auto.offsetWidth).toBe(114)
    app.renderer.simulateKeystrokes("Escape")
    expect(found.auto.offsetWidth).toBe(0)
    expect(found.manual.offsetWidth).toBe(114)
  })

  it("closes an auto popover on a press outside, and not on one inside; a manual one ignores both", () => {
    const found = mount((grab) => (
      <div style={{ width: WINDOW.width, height: WINDOW.height }}>
        <div ref={grab("auto")} popover="">
          <div style={popoverStyle} />
        </div>
        <div ref={grab("manual")} popover="manual" style={{ top: 10, left: 10, margin: 0 }}>
          <div style={popoverStyle} />
        </div>
      </div>
    ))
    found.manual.showPopover()
    found.auto.showPopover()
    app.renderer.nativeSimulateClick(WINDOW.width / 2, WINDOW.height / 2)
    expect(found.auto.offsetWidth, "a press inside").toBe(114)
    app.renderer.nativeSimulateClick(WINDOW.width - 5, WINDOW.height - 5)
    expect(found.auto.offsetWidth, "a press outside").toBe(0)
    expect(found.manual.offsetWidth).toBe(114)
  })

  it("hides the other auto popovers when one is shown, but not the one that holds it", () => {
    const found = mount((grab) => (
      <div>
        <div ref={grab("parent")} popover="auto">
          <div ref={grab("child")} popover="auto">
            <div style={popoverStyle} />
          </div>
        </div>
        <div ref={grab("sibling")} popover="auto">
          <div style={popoverStyle} />
        </div>
        <div ref={grab("manual")} popover="manual">
          <div style={popoverStyle} />
        </div>
      </div>
    ))
    found.manual.showPopover()
    found.parent.showPopover()
    found.child.showPopover()
    expect(found.parent.offsetWidth, "the one that holds it stays").toBeGreaterThan(0)
    expect(found.child.offsetWidth).toBeGreaterThan(0)
    found.sibling.showPopover()
    expect(found.parent.offsetWidth).toBe(0)
    expect(found.child.offsetWidth).toBe(0)
    expect(found.sibling.offsetWidth).toBeGreaterThan(0)
    expect(found.manual.offsetWidth, "a manual popover is not hidden").toBeGreaterThan(0)
  })

  it("hides without events when it is removed while open, and can be shown again when it is back", async () => {
    const found = mount((grab) => (
      <div>
        <div ref={grab("box")} popover="manual">
          <div style={popoverStyle} />
        </div>
      </div>
    ))
    const seen: string[] = []
    found.box.addEventListener("beforetoggle", () => seen.push("beforetoggle"))
    found.box.showPopover()
    await nextTask()
    seen.length = 0
    found.box.addEventListener("toggle", () => seen.push("toggle"))
    found.box.remove()
    expect(found.box.isConnected).toBe(false)
    expect(() => found.box.showPopover()).toThrow(expect.objectContaining({ name: "InvalidStateError" }))
    found.box.hidePopover()
    await nextTask()
    expect(seen).toEqual([])
    document.body.appendChild(found.box)
    app.renderer.flush()
    expect(found.box.offsetWidth, "closed again").toBe(0)
    found.box.showPopover()
    expect(found.box.offsetWidth).toBe(114)
  })

  it("keeps the open state out of the attributes, and a clone is closed", () => {
    const found = mount((grab) => (
      <div ref={grab("box")} popover="manual" id="pop">
        <div style={popoverStyle} />
      </div>
    ))
    found.box.showPopover()
    expect(found.box.getAttributeNames().sort()).toEqual(["id", "popover"])
    const clone = found.box.cloneNode(true) as Popover
    expect(clone.getAttribute("popover")).toBe("manual")
    expect(clone.getAttributeNames().sort()).toEqual(["id", "popover"])
  })

  it("reads and writes the popover property", () => {
    const found = mount((grab) => <div ref={grab("box")} />)
    expect(found.box.popover).toBeNull()
    found.box.popover = ""
    expect(found.box.popover).toBe("auto")
    found.box.popover = "nonsense"
    expect(found.box.popover).toBe("manual")
    found.box.popover = "hint"
    expect(found.box.popover).toBe("hint")
    found.box.popover = null
    expect(found.box.popover).toBeNull()
    expect(found.box.getAttribute("popover")).toBeNull()
  })

  it("is hidden when its attribute is taken away while it is open", () => {
    const found = mount((grab) => (
      <div ref={grab("box")} popover="manual">
        <div style={popoverStyle} />
      </div>
    ))
    found.box.showPopover()
    found.box.popover = null
    expect(getComputedStyle(found.box).position, "an element again, not the top layer").toBe("static")
    found.box.popover = "manual"
    expect(found.box.offsetWidth, "and closed when it is a popover again").toBe(0)
  })
})
