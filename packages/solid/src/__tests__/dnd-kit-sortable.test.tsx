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
const LIST_WIDTH = 400
const GRAB_X = 40
const PADDING_TOP = 30
const PADDING_LEFT = 24
const GRAB_Y = PADDING_TOP + ITEM_HEIGHT / 2

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
      style={{ height: ITEM_HEIGHT }}
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
        <div style={{ paddingTop: PADDING_TOP, paddingLeft: PADDING_LEFT }}>
          <div style={{ width: LIST_WIDTH }}>
            <For each={items()}>{(id, index) => <Item id={id} index={index()} />}</For>
          </div>
        </div>
      </DragDropProvider>
    ))
    return items
  }

  let pointerY = GRAB_Y

  async function grabFirstItem() {
    pointerY = GRAB_Y
    app.renderer.nativeSimulateMouseDown(GRAB_X, pointerY)
    await frame(16)
  }

  /** Move the pointer down to `y` in steps of 10 with a frame between. */
  async function moveTo(y: number) {
    while (pointerY < y) {
      pointerY += 10
      app.renderer.nativeSimulateMouseMove(GRAB_X, pointerY)
      await frame(16)
    }
  }

  const dndMarks = (el: HTMLElement) => el.getAttributeNames().filter((name) => name.startsWith("data-dnd-") || name === "popover")
  const texts = (list: HTMLElement) => Array.from(list.children, (child) => child.textContent)
  const rect = (el: HTMLElement) => {
    const box = el.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  }

  it("reorders by dragging the first item below the third", async () => {
    const items = mount()
    await frame(0)
    const a = nodes.get("a")!
    const list = a.parentElement!
    expect(texts(list)).toEqual(["a", "b", "c", "d", "e"])

    await grabFirstItem()
    await moveTo(GRAB_Y + 50)

    // The dragged element is the one in the document, marked, and shown as a popover in the top layer.
    expect(a.getAttribute("data-dnd-dragging")).not.toBeNull()
    expect(a.getAttribute("popover")).toBe("manual")
    expect(a.matches(":popover-open")).toBe(true)
    expect(getComputedStyle(a).position).toBe("fixed")
    expect(getComputedStyle(a).display).not.toBe("none")
    // `getComputedStyle` has no `pointer-events`: the style the cascade made reads it.
    expect(app.renderer.getElement((a as unknown as { nativeId: number }).nativeId)?.style.pointerEvents).toBe("none")
    // At its own place, moved by the pointer: dnd-kit's sheet sets `left`, `top` and `width` from the item's box.
    expect(rect(a)).toEqual({ x: PADDING_LEFT, y: PADDING_TOP + 50, width: LIST_WIDTH, height: ITEM_HEIGHT })
    // Its placeholder: a clone right after it, hidden and out of the accessibility tree, holding its place.
    const placeholder = a.nextElementSibling as HTMLElement
    expect(placeholder.getAttribute("data-dnd-placeholder")).toBe("hidden")
    expect(placeholder.hasAttribute("inert")).toBe(true)
    expect(placeholder.getAttribute("aria-hidden")).toBe("true")
    expect(placeholder.textContent).toBe("a")
    expect(getComputedStyle(placeholder).visibility).toBe("hidden")
    expect(rect(placeholder)).toMatchObject({ x: PADDING_LEFT, width: LIST_WIDTH, height: ITEM_HEIGHT })
    expect(list.children).toHaveLength(6)

    await moveTo(GRAB_Y + 90)
    // dnd-kit moved the dragged element and its placeholder, together, below c.
    expect(texts(list)).toEqual(["b", "c", "a", "a", "d", "e"])
    expect(a.nextElementSibling).toBe(placeholder)
    app.renderer.nativeSimulateMouseUp(GRAB_X, pointerY)
    await frame(16)
    // The drop animation runs: the element is still the popover, marked as dropping.
    expect(a.getAttribute("data-dnd-dropping")).not.toBeNull()
    expect(a.getAnimations()).toHaveLength(1)
    for (let tick = 0; tick < 6; tick++) await frame(100)

    expect(ends).toEqual([{ canceled: false, from: 0, to: 2 }])
    expect(items()).toEqual(["b", "c", "a", "d", "e"])
    // After the drop animation: the marks and the popover are gone, and so is the placeholder.
    expect(dndMarks(a)).toEqual([])
    expect(a.getAnimations()).toEqual([])
    expect(texts(list)).toEqual(["b", "c", "a", "d", "e"])
    expect(["a", "b", "c", "d", "e"].map((id) => rect(nodes.get(id)!).y)).toEqual([110, 30, 70, 150, 190])
  })

  // dnd-kit's sheet gives the popover `left: var(--dnd-left) !important; right: unset !important` and
  // `width: var(--dnd-width)`: with the list at an offset, a sheet that did nothing leaves the box at the window's
  // origin, as the user agent style centres a `position: fixed` popover, and as wide as its text.
  it("keeps the dragged item at its own x and width", async () => {
    mount()
    await frame(0)
    const a = nodes.get("a")!
    await grabFirstItem()
    await moveTo(GRAB_Y + 50)
    expect(rect(a)).toEqual({ x: PADDING_LEFT, y: PADDING_TOP + 50, width: LIST_WIDTH, height: ITEM_HEIGHT })
    // The test ends with the drop animation running: its unmount cancels it.
    app.renderer.nativeSimulateMouseUp(GRAB_X, pointerY)
    await frame(16)
  })

  it("reorders with the keyboard: Space, ArrowDown twice, Space", async () => {
    const items = mount()
    await frame(0)
    const a = nodes.get("a")!
    const list = a.parentElement!
    // The accessibility plugin made the item focusable and a button.
    await frame(16)
    expect(a.getAttribute("tabindex")).toBe("0")
    expect(a.getAttribute("role")).toBe("button")

    app.renderer.nativeSimulateKeystrokes((a as unknown as { nativeId: number }).nativeId, "Space")
    await frame(16)
    expect(a.getAttribute("data-dnd-dragging")).not.toBeNull()
    for (const key of ["ArrowDown", "ArrowDown", "Space"]) {
      app.renderer.simulateKeystrokes(key)
      await frame(16)
    }
    for (let tick = 0; tick < 6; tick++) await frame(100)

    expect(ends).toEqual([{ canceled: false, from: 0, to: 2 }])
    expect(items()).toEqual(["b", "c", "a", "d", "e"])
    expect(texts(list)).toEqual(["b", "c", "a", "d", "e"])
    expect(dndMarks(a)).toEqual([])
    // dnd-kit hands focus back to the dragged item.
    expect(document.activeElement).toBe(a)
  })
})
