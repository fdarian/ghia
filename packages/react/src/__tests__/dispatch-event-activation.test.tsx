/** A dispatched click runs the activation behaviour of its target, as the DOM does for an uncanceled `click`. */
import { afterEach, describe, expect, it } from "vitest"
import { document, window, type DomEvent } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("dispatchEvent of a click, in React", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  afterEach(() => testRoot.unmount())

  const click = (init: object = {}) => new globalThis.PointerEvent("click", { bubbles: true, cancelable: true, ...init })

  function mountForm(buttonProps: object = {}) {
    testRoot = createTestRoot()
    const submits: Array<object | null> = []
    const nodes: Record<string, PublicInstance> = {}
    const ref = (name: string) => (instance: unknown) => {
      if (instance) nodes[name] = instance as PublicInstance
    }
    testRoot.render(
      <form onSubmit={(event: DomEvent & { submitter: object | null }) => submits.push(event.submitter)} style={{ width: 300, height: 100 }}>
        <input name="n" style={{ width: 100, height: 20 }} />
        <button ref={ref("button")} type="submit" style={{ width: 80, height: 24 }} {...buttonProps}>
          Send
        </button>
      </form>
    )
    return { nodes, submits }
  }

  function mountLabel(labelProps: object = {}) {
    testRoot = createTestRoot()
    const nodes: Record<string, PublicInstance> = {}
    const ref = (name: string) => (instance: unknown) => {
      if (instance) nodes[name] = instance as PublicInstance
    }
    testRoot.render(
      <div style={{ width: 300, height: 100 }}>
        <label ref={ref("label")} htmlFor="field" style={{ width: 80, height: 20 }} {...labelProps}>
          Name
        </label>
        <input ref={ref("field")} id="field" testId="field" style={{ width: 100, height: 20 }} />
      </div>
    )
    return nodes
  }

  const focusedTestId = () => testRoot.renderer.getElement(testRoot.renderer.getFocusedElementId()!)?.testId ?? null

  it("submits the form of a submit button, with the button as the submitter", () => {
    const { nodes, submits } = mountForm()
    expect(nodes.button.dispatchEvent(click())).toBe(true)
    expect(submits).toEqual([nodes.button])
  })

  it("submits for a click that does not bubble, and for one dispatched at the text of the button's content", () => {
    const { nodes, submits } = mountForm()
    nodes.button.dispatchEvent(click({ bubbles: false }))
    expect(submits).toHaveLength(1)
  })

  it("does nothing for a click a listener canceled", () => {
    const { nodes, submits } = mountForm({ onClick: (event: DomEvent) => event.preventDefault() })
    expect(nodes.button.dispatchEvent(click())).toBe(false)
    expect(submits).toEqual([])
  })

  it("does nothing for a click that is not a MouseEvent", () => {
    const { nodes, submits } = mountForm()
    nodes.button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }))
    expect(submits).toEqual([])
  })

  it("does nothing for another type, or for a disabled submit button", () => {
    const { nodes, submits } = mountForm()
    nodes.button.dispatchEvent(new globalThis.MouseEvent("mousedown", { bubbles: true }))
    expect(submits).toEqual([])
    testRoot.unmount()
    const disabled = mountForm({ disabled: true })
    disabled.nodes.button.dispatchEvent(click())
    expect(disabled.submits).toEqual([])
  })

  it("focuses the control of a label", () => {
    const nodes = mountLabel()
    expect(focusedTestId()).toBeNull()
    nodes.label.dispatchEvent(click())
    expect(focusedTestId()).toBe("field")
  })

  it("toggles the checkbox a label names with htmlFor", () => {
    testRoot = createTestRoot()
    const nodes: Record<string, PublicInstance> = {}
    const ref = (name: string) => (instance: unknown) => {
      if (instance) nodes[name] = instance as PublicInstance
    }
    testRoot.render(
      <div style={{ width: 300, height: 100 }}>
        <label ref={ref("label")} htmlFor="box" style={{ width: 80, height: 20 }}>
          Name
        </label>
        <input ref={ref("box")} id="box" type="checkbox" style={{ width: 20, height: 20 }} />
      </div>
    )
    const box = nodes.box as unknown as HTMLInputElement
    expect(box.checked).toBe(false)
    nodes.label.dispatchEvent(click())
    expect(box.checked).toBe(true)
  })

  it("links a label written with the attribute's own name, as React DOM does in a browser, and follows a change of it", () => {
    testRoot = createTestRoot()
    const nodes: Record<string, PublicInstance> = {}
    const ref = (name: string) => (instance: unknown) => {
      if (instance) nodes[name] = instance as PublicInstance
    }
    // `for` is not in React's types: it comes from a library's JSX or an untyped spread.
    const tree = (target: string) => (
      <div style={{ width: 300, height: 100 }}>
        <label ref={ref("label")} {...({ for: target } as object)} style={{ width: 80, height: 20 }}>
          Name
        </label>
        <input ref={ref("first")} id="first" type="checkbox" style={{ width: 20, height: 20 }} />
        <input ref={ref("second")} id="second" type="checkbox" style={{ width: 20, height: 20 }} />
      </div>
    )
    testRoot.render(tree("first"))
    const label = nodes.label as unknown as HTMLLabelElement
    expect(label.htmlFor).toBe("first")
    expect(label.getAttribute("for")).toBe("first")
    nodes.label.dispatchEvent(click())
    expect((nodes.first as unknown as HTMLInputElement).checked).toBe(true)
    testRoot.render(tree("second"))
    expect(label.htmlFor).toBe("second")
    nodes.label.dispatchEvent(click())
    expect((nodes.second as unknown as HTMLInputElement).checked).toBe(true)
  })

  it("leaves focus alone for a label click a listener canceled", () => {
    const nodes = mountLabel({ onClick: (event: DomEvent) => event.preventDefault() })
    nodes.label.dispatchEvent(click())
    expect(focusedTestId()).toBeNull()
  })

  it("runs on a click the Base UI way: a PointerEvent from the element's window with the modifiers held", () => {
    const { nodes, submits } = mountForm()
    const seen: boolean[] = []
    nodes.button.addEventListener("click", ((event: PointerEvent) => seen.push(event.shiftKey, event.getModifierState("Shift"), event.isTrusted)) as never)
    const PointerEventOfWindow = nodes.button.ownerDocument.defaultView!.PointerEvent
    nodes.button.dispatchEvent(new PointerEventOfWindow("click", { bubbles: true, cancelable: true, shiftKey: true }))
    expect(seen).toEqual([true, true, false])
    expect(submits).toHaveLength(1)
    expect(document.defaultView).toBe(globalThis)
  })

  it("rejects a click dispatched again while it is being dispatched, without toggling the checkbox a second time", () => {
    testRoot = createTestRoot()
    const nodes: Record<string, PublicInstance> = {}
    testRoot.render(
      <input
        ref={(instance: unknown) => {
          if (instance) nodes.box = instance as PublicInstance
        }}
        type="checkbox"
        style={{ width: 20, height: 20 }}
      />
    )
    const seen: Array<{ checked: boolean; error: string | null }> = []
    const event = click()
    nodes.box.addEventListener("click", (() => {
      let error: string | null = null
      try {
        nodes.box.dispatchEvent(event)
      } catch (thrown) {
        error = (thrown as DOMException).name
      }
      seen.push({ checked: (nodes.box as unknown as HTMLInputElement).checked, error })
    }) as never)
    nodes.box.dispatchEvent(event)
    expect(seen).toEqual([{ checked: true, error: "InvalidStateError" }])
    expect((nodes.box as unknown as HTMLInputElement).checked).toBe(true)
  })
})
