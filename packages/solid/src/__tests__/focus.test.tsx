import { describe, expect, it } from "vitest"
import { createSignal } from "solid-js"
import { document } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { HostElement } from "../host.js"

const box = { width: 40, height: 20 }

function setup(view: () => any) {
  const app = createTestRoot({ width: 300, height: 200 })
  app.render(view)
  const renderer = app.renderer
  const focused = () => renderer.getElement(renderer.getFocusedElementId()!)?.testId ?? null
  const idOf = (testId: string) => renderer.findByTestId(testId)!.id
  const center = (testId: string): [number, number] => {
    const bounds = renderer.getElementBounds(idOf(testId))!
    return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
  }
  return { app, renderer, focused, idOf, center }
}

describe.skipIf(!hasNativeTestRenderer)("Solid focus model", () => {
  it("fires blur, focusout, focus, focusin in that order", () => {
    const log: string[] = []
    const listen = (name: string) => ({
      onFocus: () => log.push(`${name}:focus`),
      onBlur: () => log.push(`${name}:blur`),
      onFocusIn: () => log.push(`${name}:focusin`),
      onFocusOut: () => log.push(`${name}:focusout`),
    })
    // `b` is created first: a gpui subscription per element would fire its
    // focus listeners ahead of a's blur.
    const { renderer, idOf } = setup(() => (
      <div style={{ width: 200, height: 100 }}>
        <div testId="b" tabIndex={0} style={box} {...listen("b")} />
        <div testId="a" tabIndex={0} style={box} {...listen("a")} />
      </div>
    ))
    renderer.focusElement(idOf("a"))
    expect(log).toEqual(["a:focus", "a:focusin"])
    log.length = 0
    renderer.focusElement(idOf("b"))
    expect(log).toEqual(["a:blur", "a:focusout", "b:focus", "b:focusin"])
  })

  it("names focus and key events by their lowercase DOM types", () => {
    const types: string[] = []
    const record = (event: { type: string }) => types.push(event.type)
    const { renderer, idOf } = setup(() => (
      <div style={{ width: 200, height: 100 }}>
        <div
          testId="a"
          tabIndex={0}
          style={box}
          onFocus={record}
          onBlur={record}
          onFocusIn={record}
          onFocusOut={record}
          onKeyDown={record}
          onKeyUp={record}
        />
        <div testId="b" tabIndex={0} style={box} />
      </div>
    ))
    renderer.focusElement(idOf("a"))
    renderer.nativeSimulateKeystrokes(idOf("a"), "x")
    renderer.focusElement(idOf("b"))
    expect(types).toEqual(["focus", "focusin", "keydown", "keyup", "blur", "focusout"])
  })

  it("bubbles focusin and focusout but not focus and blur", () => {
    const log: string[] = []
    const { renderer, idOf } = setup(() => (
      <div
        style={{ width: 200, height: 100 }}
        onFocus={() => log.push("parent:focus")}
        onBlur={() => log.push("parent:blur")}
        onFocusIn={() => log.push("parent:focusin")}
        onFocusOut={() => log.push("parent:focusout")}
      >
        <div testId="a" tabIndex={0} style={box} />
        <div testId="b" tabIndex={0} style={box} onFocusIn={() => log.push("b:focusin")} />
      </div>
    ))
    renderer.focusElement(idOf("a"))
    expect(log).toEqual(["parent:focusin"])
    log.length = 0
    renderer.focusElement(idOf("b"))
    expect(log).toEqual(["parent:focusout", "b:focusin", "parent:focusin"])
  })

  it("is not made focusable by listeners, but ancestors still hear the keys", () => {
    const keys: string[] = []
    const { renderer, focused, idOf } = setup(() => (
      <div style={{ width: 200, height: 100 }} onKeyDown={(event) => keys.push(event.key)}>
        <div testId="listener" style={box} onKeyDown={() => {}} onFocus={() => {}} onBlur={() => {}} />
        <div testId="stop" tabIndex={-1} style={box} />
      </div>
    ))
    renderer.focusElement(idOf("listener"))
    expect(focused()).toBe(null)
    renderer.focusElement(idOf("stop"))
    expect(focused()).toBe("stop")
    renderer.simulateKeystrokes("x")
    expect(keys).toEqual(["x"])
  })

  it("orders tab stops: positive ascending, then 0s, skipping -1", () => {
    const { renderer, focused } = setup(() => (
      <div style={{ width: 280, height: 100 }}>
        <div testId="zero-1" tabIndex={0} style={box} />
        <div testId="three" tabIndex={3} style={box} />
        <div testId="minus" tabIndex={-1} style={box} />
        <div testId="one" tabIndex={1} style={box} />
        <div testId="zero-2" tabIndex={0} style={box} />
        <div testId="two" tabIndex={2} style={box} />
      </div>
    ))
    const order: (string | null)[] = []
    for (let step = 0; step < 6; step++) {
      renderer.simulateKeystrokes("Tab")
      order.push(focused())
    }
    expect(order).toEqual(["one", "two", "three", "zero-1", "zero-2", "one"])
  })

  it("follows the focus-visible heuristic", () => {
    const { renderer, idOf, center } = setup(() => (
      <div style={{ width: 280, height: 100 }}>
        <div testId="button" tabIndex={0} style={box} />
        <div testId="other" tabIndex={0} style={box} />
        <input testId="field" style={{ width: 80, height: 30 }} />
      </div>
    ))
    const visible = (testId: string) => renderer.matchesFocus(idOf(testId), ":focus-visible")

    renderer.nativeSimulateClick(...center("button"))
    expect(visible("button")).toBe(false)
    renderer.simulateKeystrokes("x")
    expect(visible("button")).toBe(true)

    renderer.nativeSimulateClick(...center("other"))
    expect(visible("other")).toBe(false)
    renderer.simulateKeystrokes("Tab")
    expect(visible("field")).toBe(true)

    renderer.nativeSimulateClick(...center("button"))
    renderer.nativeSimulateClick(...center("field"))
    expect(visible("field")).toBe(true)
  })

  it("reports focusVisible on the event", () => {
    const seen: (boolean | undefined)[] = []
    const { renderer, idOf } = setup(() => (
      <div style={{ width: 200, height: 100 }}>
        <div testId="a" tabIndex={0} style={box} onFocus={(event) => seen.push(event.focusVisible)} />
        <div testId="b" tabIndex={0} style={box} onFocus={(event) => seen.push(event.focusVisible)} />
      </div>
    ))
    // Script focus before any user input matches, like Chrome.
    renderer.focusElement(idOf("a"))
    renderer.simulateKeystrokes("Tab")
    expect(seen).toEqual([true, true])
  })

  it("matches :focus-within on every ancestor of the focused element", () => {
    let leaf!: HostElement
    let outer!: HostElement
    let sibling!: HostElement
    setup(() => (
      <div ref={outer} style={{ width: 200, height: 100 }}>
        <div style={{ width: 100, height: 50 }}>
          <div ref={leaf} tabIndex={0} style={box} />
        </div>
        <div ref={sibling} style={box} />
      </div>
    ))
    leaf.focus()
    expect([leaf.matches(":focus-within"), outer.matches(":focus-within"), sibling.matches(":focus-within")])
      .toEqual([true, true, false])
    expect([leaf.matches(":focus"), outer.matches(":focus")]).toEqual([true, false])
  })

  it("focuses, blurs and matches through the element", () => {
    let target!: HostElement
    const log: string[] = []
    const { focused } = setup(() => (
      <div style={{ width: 200, height: 100 }}>
        <div
          ref={target}
          testId="target"
          tabIndex={0}
          style={box}
          onFocus={() => log.push("focus")}
          onBlur={() => log.push("blur")}
        />
      </div>
    ))
    target.focus()
    expect(focused()).toBe("target")
    expect(target.matches(":focus")).toBe(true)
    target.blur()
    expect(focused()).toBe(null)
    expect(log).toEqual(["focus", "blur"])
    expect(target.matches(":visited")).toBe(false)
    expect(target.matches("[tabindex='0']")).toBe(true)
    expect(() => target.matches("[")).toThrow(expect.objectContaining({ name: "SyntaxError" }))
  })

  it("scrolls into view unless preventScroll is set", () => {
    let far!: HostElement
    const { renderer, idOf } = setup(() => (
      <div testId="scroller" style={{ width: 200, height: 60, overflow: "scroll" }}>
        <div style={{ width: 100, height: 300 }} />
        <div ref={far} tabIndex={0} style={{ width: 100, height: 40 }} />
      </div>
    ))
    const scrollTop = () => renderer.getScrollOffset(idOf("scroller"))?.[1] ?? 0
    far.focus({ preventScroll: true })
    expect(scrollTop()).toBe(0)
    far.blur()
    far.focus()
    expect(scrollTop()).toBeGreaterThan(0)
  })

  it("scrolls Tab and focus() to the nearest edge, and only if needed", () => {
    let visible!: HostElement
    let far!: HostElement
    const item = { width: 100, height: 40, flexShrink: 0 }
    const { renderer, focused, idOf } = setup(() => (
      <div testId="scroller" style={{ width: 200, height: 100, overflow: "scroll" }}>
        <div testId="i0" tabIndex={0} style={item} />
        <div ref={visible} testId="i1" tabIndex={0} style={item} />
        <div testId="i2" tabIndex={0} style={item} />
        <div ref={far} testId="i3" tabIndex={0} style={item} />
        <div testId="i4" tabIndex={0} style={item} />
        <div testId="i5" tabIndex={0} style={item} />
      </div>
    ))
    const scrollTop = () => renderer.getScrollOffset(idOf("scroller"))?.[1] ?? 0
    renderer.simulateKeystrokes("Tab Tab")
    expect(focused()).toBe("i1")
    expect(scrollTop()).toBe(0)
    renderer.simulateKeystrokes("Tab")
    expect(focused()).toBe("i2")
    expect(scrollTop()).toBe(20)
    visible.focus()
    expect(scrollTop()).toBe(20)
    far.focus({ preventScroll: true })
    expect(scrollTop()).toBe(20)
    far.blur()
    far.focus()
    expect(scrollTop()).toBe(60)
  })

  it("does not focus a disabled input that has a tabIndex", () => {
    const { renderer, focused, idOf, center } = setup(() => (
      <div style={{ width: 200, height: 100 }}>
        <input testId="field" disabled tabIndex={0} style={{ width: 100, height: 30 }} />
        <div testId="stop" tabIndex={0} style={box} />
      </div>
    ))
    renderer.focusElement(idOf("field"))
    expect(focused()).toBe(null)
    renderer.nativeSimulateClick(...center("field"))
    expect(focused()).toBe(null)
    renderer.simulateKeystrokes("Tab")
    expect(focused()).toBe("stop")
  })

  it("ignores focus() on an element that is not focusable", () => {
    const { renderer, focused, idOf } = setup(() => (
      <div style={{ width: 200, height: 100 }}>
        <div testId="plain" style={box} />
      </div>
    ))
    renderer.focusElement(idOf("plain"))
    expect(focused()).toBe(null)
  })

  describe("focus() on an element that is not rendered", () => {
    function scene() {
      const refs: Record<string, HostElement> = {}
      const ref = (name: string) => (el: HostElement) => (refs[name] = el)
      const [hidden, setHidden] = createSignal(true)
      const view = () => (
        <div style={{ width: 200, height: 100 }}>
          <style>{".gone { display: none }"}</style>
          <div ref={ref("stop")} testId="stop" tabIndex={0} style={box} />
          <div ref={ref("attribute")} testId="attribute" hidden tabIndex={0} style={box} />
          <div ref={ref("style")} testId="style" tabIndex={0} style={{ ...box, display: "none" }} />
          <div ref={ref("sheet")} testId="sheet" class="gone" tabIndex={0} style={box} />
          <div hidden>
            <div ref={ref("underAttribute")} testId="underAttribute" tabIndex={0} style={box} />
          </div>
          <div style={{ display: "none" }}>
            <div>
              <div ref={ref("underStyle")} testId="underStyle" tabIndex={0} style={box} />
            </div>
          </div>
          <div class="gone">
            <div ref={ref("underSheet")} testId="underSheet" tabIndex={0} style={box} />
          </div>
          <div ref={ref("toggled")} testId="toggled" hidden={hidden()} tabIndex={0} style={box} />
        </div>
      )
      return { refs, view, setHidden }
    }

    it("leaves focus where it is, for its own display, the hidden attribute, a stylesheet rule and an ancestor's", () => {
      const { refs, view } = scene()
      const { focused } = setup(view)
      refs.stop.focus()
      expect(focused()).toBe("stop")
      for (const name of ["attribute", "style", "sheet", "underAttribute", "underStyle", "underSheet", "toggled"]) {
        refs[name].focus()
        expect(focused(), name).toBe("stop")
        expect(document.activeElement, name).toBe(refs.stop)
      }
    })

    it("gives no focus event to an element it does not focus", () => {
      const log: string[] = []
      let target!: HostElement
      setup(() => (
        <div style={{ width: 200, height: 100 }}>
          <div hidden>
            <div ref={target} tabIndex={0} style={box} onFocus={() => log.push("focus")} />
          </div>
        </div>
      ))
      target.focus()
      expect(log).toEqual([])
    })

    it("leaves focus where it is for visibility: hidden or collapse and for an inert ancestor", () => {
      const refs: Record<string, HostElement> = {}
      const ref = (name: string) => (el: HostElement) => (refs[name] = el)
      const { focused } = setup(() => (
        <div style={{ width: 200, height: 100 }}>
          <div ref={ref("stop")} testId="stop" tabIndex={0} style={box} />
          <div ref={ref("hidden")} testId="hidden" tabIndex={0} style={{ ...box, visibility: "hidden" }} />
          <div ref={ref("collapsed")} testId="collapsed" tabIndex={0} style={{ ...box, visibility: "collapse" }} />
          <div style={{ visibility: "hidden" }}>
            <div ref={ref("underHidden")} testId="underHidden" tabIndex={0} style={box} />
          </div>
          <div inert>
            <div>
              <div ref={ref("underInert")} testId="underInert" tabIndex={0} style={box} />
            </div>
          </div>
        </div>
      ))
      refs.stop.focus()
      for (const name of ["hidden", "collapsed", "underHidden", "underInert"]) {
        refs[name].focus()
        expect(focused(), name).toBe("stop")
        expect(document.activeElement, name).toBe(refs.stop)
      }
    })

    it("focuses a visible element inside a visibility: hidden parent", () => {
      const refs: Record<string, HostElement> = {}
      const { focused } = setup(() => (
        <div style={{ width: 200, height: 100 }}>
          <div style={{ visibility: "hidden" }}>
            <div ref={(el) => (refs.shown = el)} testId="shown" tabIndex={0} style={{ ...box, visibility: "visible" }} />
          </div>
          <div style={{ visibility: "collapse" }}>
            <div ref={(el) => (refs.collapsedParent = el)} testId="collapsedParent" tabIndex={0} style={{ ...box, visibility: "visible" }} />
          </div>
        </div>
      ))
      refs.shown.focus()
      expect(focused()).toBe("shown")
      refs.collapsedParent.focus()
      expect(focused()).toBe("collapsedParent")
    })

    it("judges visibility and inert by what a signal wrote in the same tick", () => {
      let target!: HostElement
      const [hidden, setHidden] = createSignal(true)
      const [inert, setInert] = createSignal(true)
      const { app, focused } = setup(() => (
        <div style={{ width: 200, height: 100 }} inert={inert()}>
          <div ref={target} testId="target" tabIndex={0} style={{ ...box, visibility: hidden() ? "hidden" : "visible" }} />
        </div>
      ))
      target.focus()
      expect(focused()).toBe(null)
      app.root.flushSync(() => setInert(false))
      target.focus()
      expect(focused()).toBe(null)
      app.root.flushSync(() => setHidden(false))
      target.focus()
      expect(focused()).toBe("target")
    })

    it("focuses an element mounted in the same tick, and one made visible in the same tick", () => {
      const { refs, view, setHidden } = scene()
      const [show, setShow] = createSignal(false)
      const { app, focused } = setup(() => (
        <>
          {view()}
          {show() ? <div ref={(el) => (refs.late = el)} testId="late" tabIndex={0} style={box} /> : null}
        </>
      ))
      app.root.flushSync(() => setShow(true))
      refs.late.focus()
      expect(focused()).toBe("late")

      app.root.flushSync(() => setHidden(false))
      refs.toggled.focus()
      expect(focused()).toBe("toggled")

      app.root.flushSync(() => setHidden(true))
      refs.stop.focus()
      refs.toggled.focus()
      expect(focused()).toBe("stop")
    })
  })

  it("targets the topmost element of a press, so a backdrop does not focus the input under it", () => {
    const { renderer, focused, idOf, center } = setup(() => (
      <div style={{ width: 300, height: 200 }}>
        <input testId="field" style={{ width: 120, height: 40 }} />
        <div
          testId="backdrop"
          style={{ position: "absolute", top: 0, left: 0, width: 300, height: 200, backgroundColor: "#00000080" }}
        />
      </div>
    ))
    renderer.focusElement(idOf("field"))
    expect(focused()).toBe("field")
    renderer.nativeSimulateClick(...center("field"))
    expect(focused()).toBe(null)
  })

  it("keeps focus-visible across the window going inactive and back", () => {
    const { renderer, focused, idOf } = setup(() => (
      <div style={{ width: 280, height: 100 }}>
        <div testId="a" tabIndex={0} style={box} />
      </div>
    ))
    renderer.simulateKeystrokes("Tab")
    expect(focused()).toBe("a")
    renderer.setWindowActive(false)
    renderer.setWindowActive(true)
    expect(renderer.matchesFocus(idOf("a"), ":focus-visible")).toBe(true)
  })

  describe("when nobody called focus()", () => {
    // A press, an `autoFocus` mount and a frame move focus without a call of JS's,
    // and their events are still delivered before the input, the commit or the
    // draw returns. The wrapper drains the queue after each call, which would hide
    // a queued event, so watch below it.
    function watch(renderer: ReturnType<typeof setup>["renderer"]) {
      const sync: string[] = []
      const handler = (renderer as any).dispatchSyncEvent
      ;(renderer as any).native.setSyncEventHandler((event: any) => {
        sync.push(`${event.eventType}:${renderer.getElement(event.target)?.testId}`)
        return handler(event)
      })
      const queued = () =>
        (renderer as any).native
          .drainEvents()
          .filter((event: any) => ["focus", "blur", "focusin", "focusout"].includes(event.eventType))
          .map((event: any) => event.eventType)
      return { sync, queued }
    }

    const pressScene = (onMouseDownB: (event: any) => void = () => {}) => {
      const refs: Record<string, HostElement> = {}
      const view = () => (
        <div testId="scope" style={{ width: 200, height: 100 }}>
          <div ref={(el) => (refs.a = el)} testId="a" tabIndex={0} style={box} onMouseDown={() => {}} onFocus={() => {}} />
          <div ref={(el) => (refs.b = el)} testId="b" tabIndex={0} style={box} onMouseDown={onMouseDownB} onFocus={() => {}} onBlur={() => {}} />
          <div testId="plain" style={box} onMouseDown={() => {}} />
        </div>
      )
      return { refs, view }
    }

    it("delivers the focus of a press after its mousedown and before the press returns", () => {
      const scene = pressScene()
      const { renderer, center } = setup(scene.view)
      renderer.native.flush()
      const { sync, queued } = watch(renderer)

      renderer.native.simulateMouseDown(...center("a"), 0)
      expect(sync).toEqual(["mousedown:a", "focus:a", "focusin:a"])
      expect(document.activeElement).toBe(scene.refs.a)

      renderer.native.simulateMouseDown(...center("b"), 0)
      expect(sync.slice(3)).toEqual(["mousedown:b", "blur:a", "focusout:a", "focus:b", "focusin:b"])
      expect(document.activeElement).toBe(scene.refs.b)

      renderer.native.simulateMouseDown(...center("plain"), 0)
      expect(sync.slice(8)).toEqual(["mousedown:plain", "blur:b", "focusout:b"])
      expect(document.activeElement).toBe(document.body)
      expect(queued()).toEqual([])
    })

    it("delivers no focus events for a press whose mousedown was cancelled", () => {
      const scene = pressScene((event) => event.preventDefault())
      const { renderer, center } = setup(scene.view)
      renderer.native.flush()
      const { sync, queued } = watch(renderer)

      renderer.native.simulateMouseDown(...center("a"), 0)
      renderer.native.simulateMouseUp(...center("a"), 0)
      renderer.native.simulateMouseDown(...center("b"), 0)
      expect(sync.filter((event) => /^(focus|blur)/.test(event))).toEqual(["focus:a", "focusin:a"])
      expect(document.activeElement).toBe(scene.refs.a)
      expect(queued()).toEqual([])
    })

    it("delivers the focus events of autoFocus in the commit that mounts it", () => {
      const app = createTestRoot({ width: 300, height: 200 })
      const { sync, queued } = watch(app.renderer)
      let auto!: HostElement
      // `app.render` also draws a frame, which would deliver them too: commit only.
      app.root.render(() => (
        <div style={{ width: 200, height: 100 }}>
          <div ref={auto} testId="auto" tabIndex={0} autoFocus style={box} onFocus={() => {}} />
        </div>
      ))
      expect(sync).toEqual(["focus:auto", "focusin:auto"])
      expect(document.activeElement).toBe(auto)
      expect(queued()).toEqual([])
      app.unmount()
    })

    it("lets an autoFocus handler change state without losing the batch's own mutations", () => {
      const app = createTestRoot({ width: 300, height: 200 })
      const [label, setLabel] = createSignal("before")
      app.render(() => (
        <div style={{ width: 200, height: 100 }}>
          <div testId="auto" tabIndex={0} autoFocus style={box} onFocus={() => setLabel("after")} />
          <div testId="label" style={box}>
            <div>{label()}</div>
          </div>
        </div>
      ))
      expect(app.renderer.findByText("after")).toBeDefined()
      expect(app.renderer.findByText("before")).toBeUndefined()
      app.unmount()
    })

    it("delivers the events of a focus change a frame notices before the frame returns", () => {
      const { renderer, idOf } = setup(() => (
        <div style={{ width: 200, height: 100 }}>
          <div testId="a" tabIndex={0} style={box} onFocus={() => {}} onBlur={() => {}} />
        </div>
      ))
      renderer.focusElement(idOf("a"))
      const { sync, queued } = watch(renderer)

      // The window going inactive is GPUI's doing, and the frame reports it.
      renderer.native.setWindowActive(false)
      renderer.native.flush()
      expect(sync).toEqual(["blur:a", "focusout:a"])

      renderer.native.setWindowActive(true)
      renderer.native.flush()
      expect(sync.slice(2)).toEqual(["focus:a", "focusin:a"])
      expect(queued()).toEqual([])
    })
  })
})
