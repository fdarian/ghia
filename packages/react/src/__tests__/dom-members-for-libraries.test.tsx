/**
 * The DOM a drag-and-drop or positioning library reads from an element, on React's host elements
 * and on the ones `document.createElement` makes: selectors (`:popover-open`, on nodes that are not
 * inserted yet), the attributes a library writes (`tabindex`, `popover`, an empty one), the classes
 * of the events it is handed, and the small members (`compatMode`, `disabled`, `htmlFor`, an input's
 * state).
 */
import type { ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describeNative("DOM members that libraries read, in React", () => {
  let app: ReturnType<typeof createTestRoot> | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
  })

  /** Renders `tree` and collects the elements it gives its `ref`s by name. */
  function mount(tree: (grab: (name: string) => (instance: unknown) => void) => ReactNode): Record<string, HTMLElement> {
    app = createTestRoot({ width: 400, height: 300 })
    const found: Record<string, HTMLElement> = {}
    const grab = (name: string) => (instance: unknown) => {
      if (instance !== null) found[name] = instance as HTMLElement
    }
    app.render(tree(grab))
    return found
  }

  const box = { width: 80, height: 40 }

  describe("selectors", () => {
    it(":popover-open matches a popover that is showing, in matches, closest, querySelector and querySelectorAll", () => {
      const found = mount((grab) => (
        <div ref={grab("outer")} style={{ width: 300, height: 200 }}>
          <div ref={grab("pop")} popover="manual">
            <span ref={grab("inner")} style={box} />
          </div>
          <div ref={grab("other")} popover="manual" />
        </div>
      ))
      expect(found.pop.matches(":popover-open")).toBe(false)
      expect(found.outer.matches(":popover-open")).toBe(false)
      expect(found.outer.querySelector(":popover-open")).toBeNull()
      expect(found.outer.querySelectorAll("[popover]:not(:popover-open)")).toHaveLength(2)

      found.pop.showPopover()
      expect(found.pop.matches(":popover-open")).toBe(true)
      expect(found.other.matches(":popover-open")).toBe(false)
      expect(found.inner.closest(":popover-open")).toBe(found.pop)
      expect(found.outer.querySelector(":popover-open")).toBe(found.pop)
      expect([...document.querySelectorAll(":popover-open")]).toEqual([found.pop])
      expect(found.outer.querySelectorAll("[popover]:not(:popover-open)")).toHaveLength(1)

      found.pop.hidePopover()
      expect(found.pop.matches(":popover-open")).toBe(false)
      expect(found.inner.closest(":popover-open")).toBeNull()
    })

    it("answers matches, closest and querySelector on elements that are not inserted, and on subtrees built before insertion", () => {
      mount(() => <div />)
      const item = document.createElement("div")
      item.setAttribute("data-dnd", "1")
      item.setAttribute("class", "drag item")
      expect(item.matches('[data-dnd="1"].drag')).toBe(true)
      expect(item.matches("div:not(.nope)")).toBe(true)
      expect(item.matches(":popover-open")).toBe(false)
      expect(item.closest(".item")).toBe(item)
      expect(item.closest(".missing")).toBeNull()

      const list = document.createElement("ul")
      const first = document.createElement("li")
      const second = document.createElement("li")
      first.setAttribute("id", "first")
      second.setAttribute("class", "last")
      list.appendChild(first)
      list.appendChild(second)
      const checks = () => {
        expect(list.querySelector("#first")).toBe(first)
        expect([...list.querySelectorAll("li")]).toEqual([first, second])
        expect(list.querySelector(":scope > li:last-child")).toBe(second)
        expect(second.closest("ul")).toBe(list)
        expect(first.matches("ul > li:first-child")).toBe(true)
        expect(second.matches("li + li.last")).toBe(true)
        expect(first.matches(":scope")).toBe(true)
      }
      checks()
      expect(list.isConnected).toBe(false)

      document.body!.appendChild(list)
      expect(list.isConnected).toBe(true)
      checks()
      expect(document.querySelector("#first")).toBe(first)
      expect(second.closest("body")).toBe(document.body)
      list.remove()
    })

    it("document.querySelectorAll('iframe, frame') is an empty list", () => {
      mount(() => <div />)
      const frames = document.querySelectorAll("iframe, frame")
      expect(frames).toHaveLength(0)
      expect([...frames]).toEqual([])
    })
  })

  describe("attributes", () => {
    it("setAttribute('tabindex') makes an element focusable and removeAttribute('tabindex') undoes it", () => {
      const found = mount((grab) => <div ref={grab("box")} style={box} />)
      found.box.focus()
      expect(document.activeElement).not.toBe(found.box)
      expect(found.box.tabIndex).toBe(-1)

      found.box.setAttribute("tabindex", "0")
      expect(found.box.tabIndex).toBe(0)
      expect(found.box.getAttribute("tabindex")).toBe("0")
      found.box.focus()
      expect(document.activeElement).toBe(found.box)

      found.box.blur()
      found.box.removeAttribute("tabindex")
      expect(found.box.tabIndex).toBe(-1)
      expect(found.box.getAttribute("tabindex")).toBeNull()
      found.box.focus()
      expect(document.activeElement).not.toBe(found.box)

      found.box.setAttribute("tabindex", "-1")
      found.box.focus()
      expect(document.activeElement).toBe(found.box)
    })

    it("setAttribute(name, '') reads back \"\" and is present", () => {
      const found = mount((grab) => <div ref={grab("box")} style={box} />)
      const created = document.createElement("div")
      for (const element of [found.box, created]) {
        for (const name of ["data-dnd", "title", "aria-hidden", "role"]) {
          element.setAttribute(name, "")
          expect(element.getAttribute(name), name).toBe("")
          expect(element.hasAttribute(name), name).toBe(true)
          expect(element.getAttributeNames(), name).toContain(name)
          element.removeAttribute(name)
          expect(element.hasAttribute(name), name).toBe(false)
        }
      }
    })

    it("setAttribute('popover') and removeAttribute('popover') hide a popover whose kind they change, as the popover property does", async () => {
      const found = mount((grab) => (
        <div>
          <div ref={grab("auto")} popover="auto" />
          <div ref={grab("manual")} popover="manual" />
        </div>
      ))
      const states: string[] = []
      found.auto.addEventListener("toggle", (event) => states.push((event as ToggleEvent).newState))
      found.auto.showPopover()
      await nextTask()
      expect(states).toEqual(["open"])

      found.auto.setAttribute("popover", "")
      expect(found.auto.popover).toBe("auto")
      expect(found.auto.matches(":popover-open"), "still an auto popover").toBe(true)
      found.auto.setAttribute("popover", "manual")
      expect(found.auto.matches(":popover-open")).toBe(false)
      await nextTask()
      expect(states).toEqual(["open", "closed"])

      found.manual.showPopover()
      expect(found.manual.matches(":popover-open")).toBe(true)
      found.manual.removeAttribute("popover")
      expect(found.manual.matches(":popover-open")).toBe(false)
      expect(found.manual.popover).toBeNull()
      expect(() => found.manual.showPopover()).toThrowError(expect.objectContaining({ name: "NotSupportedError" }))
    })
  })

  describe("events", () => {
    it("are instances of the global PointerEvent, MouseEvent, KeyboardEvent and FocusEvent", () => {
      const found = mount((grab) => (
        <div style={{ width: 300, height: 200 }}>
          <div ref={grab("box")} tabIndex={0} style={box} />
        </div>
      ))
      // The global `window` is the global object, which is where `dom-globals` puts the classes.
      const window = Reflect.get(globalThis, "window") as typeof globalThis
      expect(window.PointerEvent).toBe(globalThis.PointerEvent)
      const seen: Record<string, Event> = {}
      for (const type of ["pointerdown", "mousedown", "click", "keydown", "focus", "focusin"]) {
        found.box.addEventListener(type, (event) => {
          seen[type] = event
        })
      }
      const bounds = found.box.getBoundingClientRect()
      app!.renderer.nativeSimulateClick(bounds.x + 10, bounds.y + 10)
      app!.renderer.simulateKeystrokes("a")

      for (const owner of [window, globalThis] as const) {
        expect(seen.pointerdown).toBeInstanceOf(owner.PointerEvent)
        expect(seen.pointerdown).toBeInstanceOf(owner.MouseEvent)
        expect(seen.mousedown).toBeInstanceOf(owner.MouseEvent)
        expect(seen.click).toBeInstanceOf(owner.MouseEvent)
        expect(seen.keydown).toBeInstanceOf(owner.KeyboardEvent)
        expect(seen.focus).toBeInstanceOf(owner.FocusEvent)
        expect(seen.focusin).toBeInstanceOf(owner.FocusEvent)
      }
    })
  })

  describe("small members", () => {
    it("document.compatMode is CSS1Compat", () => {
      mount(() => <div />)
      expect(document.compatMode).toBe("CSS1Compat")
    })

    // `select`, `optgroup` and `option` are not elements Ghia draws, so `createElement` refuses them.
    it("reflects disabled on the elements that have it, through the attribute", () => {
      const found = mount((grab) => (
        <div>
          <button ref={grab("button")} />
          <fieldset ref={grab("fieldset")} />
          <div ref={grab("div")} />
        </div>
      ))
      const created = ["button", "input", "textarea", "fieldset"].map((tag) => document.createElement(tag))
      for (const element of [found.button, found.fieldset, ...created]) {
        const tag = element.localName
        expect((element as HTMLButtonElement).disabled, tag).toBe(false)
        ;(element as HTMLButtonElement).disabled = true
        expect(element.getAttribute("disabled"), tag).toBe("")
        expect(element.hasAttribute("disabled"), tag).toBe(true)
        expect((element as HTMLButtonElement).disabled, tag).toBe(true)
        element.removeAttribute("disabled")
        expect((element as HTMLButtonElement).disabled, tag).toBe(false)
        element.setAttribute("disabled", "disabled")
        expect((element as HTMLButtonElement).disabled, tag).toBe(true)
        ;(element as HTMLButtonElement).disabled = false
        expect(element.hasAttribute("disabled"), tag).toBe(false)
      }
      const other = document.createElement("div")
      expect("disabled" in found.div && (found.div as { disabled?: unknown }).disabled).toBeFalsy()
      expect((other as { disabled?: unknown }).disabled).toBeUndefined()
    })

    it("reflects htmlFor on a label through the for attribute", () => {
      const found = mount((grab) => (
        <div>
          <label ref={grab("label")} htmlFor="field" />
          <input id="field" />
        </div>
      ))
      const created = document.createElement("label")
      expect(found.label.htmlFor).toBe("field")
      expect(created.htmlFor).toBe("")
      created.htmlFor = "x"
      expect(created.getAttribute("for")).toBe("x")
      expect(created.htmlFor).toBe("x")
      found.label.setAttribute("for", "other")
      expect(found.label.htmlFor).toBe("other")
      found.label.htmlFor = "third"
      expect(found.label.getAttribute("for")).toBe("third")
      found.label.removeAttribute("for")
      expect(found.label.htmlFor).toBe("")
      expect((document.createElement("div") as { htmlFor?: unknown }).htmlFor).toBeUndefined()
    })

    it("works on an input made by createElement once it is inserted: checked, value, valueAsNumber, stepUp", () => {
      mount(() => <div />)
      const checkbox = document.createElement("input") as HTMLInputElement
      checkbox.setAttribute("type", "checkbox")
      document.body!.appendChild(checkbox)
      expect(checkbox.getAttribute("type")).toBe("checkbox")
      expect(checkbox.checked).toBe(false)
      checkbox.checked = true
      expect(checkbox.checked).toBe(true)
      expect(checkbox.matches(":checked")).toBe(true)
      expect(checkbox.value).toBe("on")

      const text = document.createElement("input") as HTMLInputElement
      document.body!.appendChild(text)
      expect(text.value).toBe("")
      text.value = "hello"
      expect(text.value).toBe("hello")
      expect(text.valueAsNumber).toBeNaN()

      const range = document.createElement("input") as HTMLInputElement
      range.setAttribute("type", "range")
      range.setAttribute("min", "0")
      range.setAttribute("max", "10")
      range.setAttribute("step", "2")
      document.body!.appendChild(range)
      range.value = "4"
      expect(range.valueAsNumber).toBe(4)
      range.stepUp()
      expect(range.valueAsNumber).toBe(6)
      range.stepUp(2)
      expect(range.value).toBe("10")
      checkbox.remove()
      text.remove()
      range.remove()
    })

    it("an input made by createElement before it is inserted reads its attributes, and has no state to assign until it is mounted", () => {
      mount(() => <div />)
      const input = document.createElement("input") as HTMLInputElement
      input.setAttribute("type", "number")
      input.setAttribute("value", "3")
      input.setAttribute("checked", "")
      expect(input.getAttribute("type")).toBe("number")
      expect(input.value).toBe("3")
      expect(input.checked).toBe(true)
      expect(input.valueAsNumber).toBe(3)
      expect(() => {
        input.value = "4"
      }).toThrowError("needs a mounted element")
      expect(() => {
        input.checked = false
      }).toThrowError("needs a mounted element")
      expect(() => input.stepUp()).toThrowError("needs a mounted element")
    })
  })
})
