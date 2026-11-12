/**
 * A real @dnd-kit/solid sortable (@dnd-kit/dom 0.5.3: default feedback, pointer and keyboard sensors) on the test
 * renderer: five items in a column, one grabbed, dragged over the others and dropped. Nothing in this file stands in
 * for the DOM: it is the proof that the sortable runs unchanged.
 */
import { For, createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DragDropProvider } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const ITEM_HEIGHT = 40
const ITEM_WIDTH = 200

const nodes = new Map<string, HTMLElement>()

function Item(props: { id: string; index: number }) {
  const sortable = useSortable({
    id: props.id,
    get index() {
      return props.index
    },
  })
  return (
    <div
      ref={(element) => {
        nodes.set(props.id, element as unknown as HTMLElement)
        sortable.ref(element)
      }}
      testId={props.id}
      style={{ height: ITEM_HEIGHT, width: ITEM_WIDTH }}
    >
      {props.id}
    </div>
  )
}

describe.skipIf(!hasNativeTestRenderer)("@dnd-kit/solid sortable on Ghia", () => {
  let app: ReturnType<typeof createTestRoot>
  const ends: { canceled: boolean; from: number; to: number }[] = []

  beforeEach(() => {
    ends.length = 0
    nodes.clear()
    app = createTestRoot()
    app.renderer.clockPause()
  })

  afterEach(() => {
    app.unmount()
  })

  async function settle() {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
  }

  async function frame(ms: number) {
    app.renderer.clockFastForward(ms)
    app.renderer.flush()
    app.renderer.drawFrame()
    app.renderer.dispatchNativeEvents()
    await settle()
    app.renderer.flush()
  }

  function mount() {
    const [items, setItems] = createSignal(["a", "b", "c", "d", "e"])
    app.render(() => (
      <DragDropProvider
        onDragEnd={(event) => {
          const source = event.operation.source
          if (!isSortable(source)) return
          ends.push({ canceled: event.canceled, from: source.initialIndex, to: source.index })
          if (event.canceled) return
          setItems((current) => {
            const next = current.slice()
            const [moved] = next.splice(source.initialIndex, 1)
            next.splice(source.index, 0, moved)
            return next
          })
        }}
      >
        <div style={{ width: 400, height: 400 }}>
          <For each={items()}>{(id, index) => <Item id={id} index={index()} />}</For>
        </div>
      </DragDropProvider>
    ))
    return items
  }

  /** Mouse down on the first item, then move to `y` in steps of 10 with a frame between. */
  async function dragFirstItemTo(y: number) {
    app.renderer.nativeSimulateMouseDown(20, 20)
    await frame(16)
    for (let at = 30; at <= y; at += 10) {
      app.renderer.nativeSimulateMouseMove(20, at)
      await frame(16)
    }
  }

  const rowsOf = () => [...nodes.values()].map((el) => `${el.textContent}:${Math.round(el.getBoundingClientRect().top)}`)
  const rect = (el: HTMLElement) => {
    const box = el.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  }

  it("reorders by dragging the first item below the third", async () => {
    const items = mount()
    await frame(0)
    const a = nodes.get("a")!
    const list = a.parentElement!
    expect(list.children.map((child) => child.textContent)).toEqual(["a", "b", "c", "d", "e"])

    await dragFirstItemTo(70)

    // The dragged element is the one in the document, marked, and shown as a popover in the top layer.
    expect(a.getAttribute("data-dnd-dragging")).not.toBeNull()
    expect(a.getAttribute("popover")).toBe("manual")
    expect(getComputedStyle(a).position).toBe("fixed")
    expect(getComputedStyle(a).display).not.toBe("none")
    expect(rect(a)).toMatchObject({ y: 50, width: ITEM_WIDTH, height: ITEM_HEIGHT })
    // Its placeholder: a clone right after it, hidden and out of the accessibility tree, holding its place.
    const placeholder = a.nextElementSibling as HTMLElement
    expect(placeholder.getAttribute("data-dnd-placeholder")).toBe("hidden")
    // A boolean attribute reads back as present, not as the text written (docs/fork/deviations.md).
    expect(placeholder.getAttribute("inert")).not.toBeNull()
    expect(placeholder.getAttribute("aria-hidden")).toBe("true")
    expect(placeholder.textContent).toBe("a")
    expect(getComputedStyle(placeholder).visibility).toBe("hidden")
    expect(rect(placeholder)).toMatchObject({ width: ITEM_WIDTH, height: ITEM_HEIGHT })
    expect(list.children).toHaveLength(6)

    await dragFirstItemTo(110)
    app.renderer.nativeSimulateMouseUp(20, 110)
    await frame(16)
    // The drop animation runs: the element is still the popover, marked as dropping.
    expect(a.getAttribute("data-dnd-dropping")).not.toBeNull()
    expect(a.getAnimations()).toHaveLength(1)
    for (let tick = 0; tick < 6; tick++) await frame(100)

    expect(ends).toEqual([{ canceled: false, from: 0, to: 2 }])
    expect(items()).toEqual(["b", "c", "a", "d", "e"])
    // After the drop animation: the marks and the popover are gone, and so is the placeholder.
    expect(a.getAttributeNames().filter((name) => name.startsWith("data-dnd-") || name === "popover")).toEqual([])
    expect(a.getAnimations()).toEqual([])
    expect(list.children.map((child) => child.textContent)).toEqual(["b", "c", "a", "d", "e"])
    expect(rowsOf().sort()).toEqual(["a:80", "b:0", "c:40", "d:120", "e:160"])
  })

  // dnd-kit's sheet gives the popover `left: var(--dnd-left) !important; right: unset !important`, which puts the
  // box at its own x, not centred across the window by the user agent style.
  it("keeps the dragged item at its own x", async () => {
    mount()
    await frame(0)
    const a = nodes.get("a")!
    await dragFirstItemTo(70)
    const x = rect(a).x
    // Let the drop animation finish: an unmount that cancels it is an unhandled AbortError (see the notes).
    app.renderer.nativeSimulateMouseUp(20, 70)
    for (let tick = 0; tick < 8; tick++) await frame(100)
    expect(x).toBe(0)
  })

  it("reorders with the keyboard: Space, ArrowDown twice, Space", async () => {
    const items = mount()
    await frame(0)
    const a = nodes.get("a")!
    const id = (a as unknown as { nativeId: number }).nativeId
    // The accessibility plugin made the item focusable and a button.
    await frame(16)
    expect(a.getAttribute("tabindex")).toBe("0")
    expect(a.getAttribute("role")).toBe("button")
    for (const key of ["Space", "ArrowDown", "ArrowDown", "Space"]) {
      app.renderer.nativeSimulateKeyDown(id, key)
      await frame(16)
    }
    for (let tick = 0; tick < 6; tick++) await frame(100)
    expect(ends).toEqual([{ canceled: false, from: 0, to: 2 }])
    expect(items()).toEqual(["b", "c", "a", "d", "e"])
    expect(a.getAttributeNames().filter((name) => name.startsWith("data-dnd-") || name === "popover")).toEqual([])
  })
})
