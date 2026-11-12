import { Suspense } from "react"
import { describe, expect, it, vi } from "vitest"
import { handleGpuixEvent } from "../reconciler/event-registry.js"
import { hostConfig, markUnmounted, materialize } from "../reconciler/host-config.js"
import { createRoot, flushSync } from "../reconciler/reconciler.js"
import { createTestRoot, hasNativeTestRenderer, TestRenderer } from "../testing.js"
import type {
  Container,
  HostContext,
  MutationRenderer,
  Props,
} from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function recordingRenderer(): MutationRenderer & { styles: object[] } {
  const styles: object[] = []
  const deferred = new Map<object, () => void>()
  return {
    styles,
    createElement() {},
    destroyElement: () => [],
    appendChild() {},
    detachChild() {},
    insertBefore() {},
    setStyle(_id, style) {
      styles.push(style)
    },
    setText() {},
    setEventListener() {},
    setRoot() {},
    setKeyboardFocusDim() {},
    setUniversalStyle() {},
    setCustomProp() {},
    setAttribute() {},
    setStyleSheet() {},
    setAdoptedStyleSheets() {},
    requestFlush() {},
    deferWrite(key, write) {
      deferred.set(key, write)
    },
    flushMutations() {
      const writes = [...deferred.values()]
      deferred.clear()
      for (const write of writes) write()
    },
  }
}

function hiddenFixture(props: Props, mounted = true) {
  const renderer = recordingRenderer()
  const container: Container = {
    nativeRenderer: {},
    renderer,
    ids: { nextElementId: 0 },
    eventHandlers: new Map(),
    motionBindings: new Map(),
    motionReleases: [],
    instances: new Map(),
    windowKeyEventHandlers: {},
    windowKeyEventId: 0,
    windowSelectionEventId: 0,
    onUncaughtError: () => {},
  }
  const instance = hostConfig.createInstance("div", props, container, null as unknown as HostContext)
  if (mounted) materialize(instance)
  return { renderer, instance }
}

describe("host config hideInstance", () => {
  it("hides through the live style, so the element reads display none with priority important", () => {
    const props: Props = {
      style: {
        width: 80,
        height: 40,
        backgroundColor: "#f38ba8",
        hover: { backgroundColor: "#a6e3a1" },
      },
    }
    const { renderer, instance } = hiddenFixture(props)

    hostConfig.hideInstance(instance)
    renderer.flushMutations()
    expect(renderer.styles.at(-1)).toEqual({ ...props.style, display: "none !important" })
    expect([instance.style.display, instance.style.getPropertyPriority("display")]).toEqual(["none", "important"])
    expect(instance.getAttribute("style")).toBe("width: 80px; height: 40px; background-color: #f38ba8; display: none !important;")

    hostConfig.unhideInstance(instance, props)
    renderer.flushMutations()
    expect(renderer.styles.at(-1)).toEqual(props.style)
    expect(instance.style.display).toBe("")
  })

  it("keeps an element hidden when its style changes", () => {
    const before: Props = { style: { width: 80, hover: { backgroundColor: "#a6e3a1" } } }
    const after: Props = { style: { width: 120, hover: { backgroundColor: "#a6e3a1" } } }
    const { renderer, instance } = hiddenFixture(before)

    hostConfig.hideInstance(instance)
    renderer.flushMutations()
    hostConfig.commitUpdate(instance, "div", before, after, null)
    expect(renderer.styles.at(-1)).toEqual({ ...after.style, display: "none !important" })

    hostConfig.unhideInstance(instance, after)
    renderer.flushMutations()
    expect(renderer.styles.at(-1)).toEqual(after.style)
  })

  it("sends the hidden style first when an unmaterialized element is hidden and then materialized", () => {
    const { renderer, instance } = hiddenFixture({ style: { width: 80, hover: { backgroundColor: "#a6e3a1" } } }, false)

    hostConfig.hideInstance(instance)
    renderer.flushMutations()
    expect(renderer.styles).toHaveLength(0)

    materialize(instance)
    expect(renderer.styles[0]).toEqual({ width: 80, hover: { backgroundColor: "#a6e3a1" }, display: "none !important" })
  })

  it("does not resend an unchanged style while hidden", () => {
    const { renderer, instance } = hiddenFixture({ style: { width: 80 } })
    hostConfig.hideInstance(instance)
    renderer.flushMutations()
    const sent = renderer.styles.length

    hostConfig.commitUpdate(
      instance,
      "div",
      { style: { width: 80 } },
      { style: { width: 80 } },
      null
    )
    renderer.flushMutations()

    expect(renderer.styles).toHaveLength(sent)
  })

  it("unhides to the display the props give, and drops one that code wrote while it was hidden", () => {
    const { renderer, instance } = hiddenFixture({ style: { width: 80 } })
    hostConfig.hideInstance(instance)
    instance.style.display = "flex"
    hostConfig.unhideInstance(instance, { style: { width: 80 } })
    renderer.flushMutations()
    expect(renderer.styles.at(-1)).toEqual({ width: 80 })
    expect(instance.style.display).toBe("")

    hostConfig.hideInstance(instance)
    hostConfig.unhideInstance(instance, { style: { width: 80, display: " grid " } })
    renderer.flushMutations()
    expect(renderer.styles.at(-1)).toEqual({ width: 80, display: "grid" })
  })
})

describe("the deferred style write of code", () => {
  it("is dropped when a React commit sent the same live style before the flush", () => {
    const before: Props = { style: { width: 80 } }
    const after: Props = { style: { width: 80, opacity: 0.5 } }
    const { renderer, instance } = hiddenFixture(before)
    renderer.flushMutations()
    const sent = renderer.styles.length

    instance.style.opacity = "0.5"
    hostConfig.commitUpdate(instance, "div", before, after, null)
    expect(renderer.styles).toHaveLength(sent + 1)
    renderer.flushMutations()
    expect(renderer.styles).toHaveLength(sent + 1)
  })

  it("is dropped when the element was released before the flush", () => {
    const { renderer, instance } = hiddenFixture({ style: { width: 80 } })
    renderer.flushMutations()
    const sent = renderer.styles.length

    instance.style.height = "10px"
    markUnmounted(instance)
    renderer.flushMutations()
    expect(renderer.styles).toHaveLength(sent)
  })
})

describeNative("mutation lifecycle", () => {
  it("does not paint host nodes from an abandoned Suspense render", () => {
    const { render, renderer, unmount } = createTestRoot()
    const pending = new Promise<never>(() => {})

    function Suspend(): never {
      throw pending
    }

    try {
      render(
        <Suspense fallback={<div>fallback</div>}>
          <div>
            <div>abandoned</div>
          </div>
          <Suspend />
        </Suspense>
      )

      expect(renderer.getPaintedText()).toEqual(["fallback"])
    } finally {
      unmount()
    }
  })

  it("keeps unchanged event handlers registered across renders", () => {
    const { render, renderer, unmount } = createTestRoot()
    const onClick = vi.fn()
    const clickable = (
      <div style={{ width: 100, height: 100 }} onClick={onClick}>
        click
      </div>
    )

    try {
      render(clickable)
      renderer.nativeSimulateClick(10, 10)
      render(clickable)
      renderer.nativeSimulateClick(10, 10)

      expect(onClick).toHaveBeenCalledTimes(2)
    } finally {
      unmount()
    }
  })

  it("keeps element ids and click handlers isolated across roots", () => {
    const onA = vi.fn()
    const onB = vi.fn()
    const click = { elementId: 5, eventType: "click" }
    const a = createTestRoot()
    // The window is per thread: the second renderer takes it over, so each root is read
    // before the next one is made.
    let b: ReturnType<typeof createTestRoot> | undefined

    try {
      a.render(
        <div style={{ width: 100, height: 100 }} onClick={onA}>
          a
        </div>
      )
      // Ids 1, 2 and 3 are the window's html, head and body.
      expect(a.renderer.findByType("#text")[0]?.id).toBe(4)
      expect(a.renderer.getRoot()?.id).toBe(5)
      handleGpuixEvent(click, a.renderer)
      expect(onA).toHaveBeenCalledTimes(1)

      b = createTestRoot()
      b.render(
        <div style={{ width: 100, height: 100 }} onClick={onB}>
          b
        </div>
      )
      expect(b.renderer.findByType("#text")[0]?.id).toBe(4)
      expect(b.renderer.getRoot()?.id).toBe(5)

      handleGpuixEvent(click, b.renderer)
      expect(onA).toHaveBeenCalledTimes(1)
      expect(onB).toHaveBeenCalledTimes(1)

      handleGpuixEvent(click, a.renderer)
      expect(onA).toHaveBeenCalledTimes(2)
      expect(onB).toHaveBeenCalledTimes(1)
    } finally {
      a.unmount()
      b?.unmount()
    }
  })

  it("does not give a remounted root the old element ids", () => {
    const renderer = new TestRenderer()
    const first = createRoot(renderer)
    const onFirst = vi.fn()
    const onSecond = vi.fn()
    const tree = (onClick: () => void) => (
      <div style={{ width: 100, height: 100 }} onClick={onClick}>
        row
      </div>
    )

    flushSync(() => first.render(tree(onFirst)))
    renderer.flush()
    const firstRootId = renderer.getRoot()?.id
    // After the first root's html, head and body, and the text in it.
    expect(firstRootId).toBe(5)
    first.unmount()

    const second = createRoot(renderer)
    try {
      flushSync(() => second.render(tree(onSecond)))
      renderer.flush()
      expect(renderer.getRoot()?.id).not.toBe(firstRootId)

      handleGpuixEvent({ elementId: firstRootId!, eventType: "click" }, renderer)
      expect(onSecond).not.toHaveBeenCalled()
    } finally {
      second.unmount()
    }
  })

  // React calls `detachDeletedInstance` only for host components, never for a
  // host text node, so a removed string used to stay in the retained tree with
  // no parent and no way back to it.
  it("frees a removed text node instead of leaking it", () => {
    const { render, renderer, unmount } = createTestRoot()

    try {
      render(<div style={{ width: 100, height: 100 }}>{"hello"}</div>)
      const withText = renderer.getRetainedElementCount()

      render(<div style={{ width: 100, height: 100 }}>{null}</div>)
      expect(renderer.getAllText()).toEqual([])
      expect(renderer.getRetainedElementCount()).toBe(withText - 1)

      // A whole removed subtree frees every node in it, not just its root.
      render(
        <div style={{ width: 100, height: 100 }}>
          <div>
            <div>deep</div>
          </div>
        </div>
      )
      const withSubtree = renderer.getRetainedElementCount()
      expect(withSubtree).toBe(withText + 2)

      render(<div style={{ width: 100, height: 100 }}>{null}</div>)
      expect(renderer.getRetainedElementCount()).toBe(withText - 1)
    } finally {
      unmount()
    }
  })

  it("refuses a second simultaneous root on one renderer", () => {
    const renderer = new TestRenderer()
    const onFirstKey = vi.fn()
    const first = createRoot(renderer, { onKeyDown: onFirstKey })
    const onFirst = vi.fn()

    try {
      flushSync(() =>
        first.render(
          <div style={{ width: 100, height: 100 }} onClick={onFirst}>
            first
          </div>
        )
      )
      renderer.flush()

      expect(() => createRoot(renderer)).toThrowErrorMatchingInlineSnapshot(
        `[Error: This renderer already drives a mounted GPUIX root. One renderer owns one window, one native root id, and one event map, so a second root would silently take both over. Unmount the first root first.]`
      )

      // The rejected root must not have disturbed the live one.
      handleGpuixEvent({ elementId: renderer.getRoot()!.id, eventType: "click" }, renderer)
      expect(onFirst).toHaveBeenCalledTimes(1)
      renderer.simulateKeystrokes("Tab")
      expect(onFirstKey).toHaveBeenCalledTimes(1)
    } finally {
      first.unmount()
    }
  })

  it("allows a new root once the previous one unmounts", () => {
    const renderer = new TestRenderer()
    const first = createRoot(renderer)
    flushSync(() => first.render(<div>first</div>))
    renderer.flush()
    first.unmount()

    const second = createRoot(renderer)
    const onSecond = vi.fn()
    try {
      flushSync(() =>
        second.render(
          <div style={{ width: 100, height: 100 }} onClick={onSecond}>
            second
          </div>
        )
      )
      renderer.flush()
      handleGpuixEvent({ elementId: renderer.getRoot()!.id, eventType: "click" }, renderer)
      expect(onSecond).toHaveBeenCalledTimes(1)
    } finally {
      second.unmount()
    }
  })
})
