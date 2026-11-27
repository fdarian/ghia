import { describe, expect, it } from "vitest"
import "../dom-globals.js"
import {
  document,
  documentOf,
  elementOf,
  forgetElementSource,
  forgetWindowSource,
  installElementSource,
  noteFocusEvent,
} from "../events/window-target.js"

function root(elements: Record<number, object>) {
  const state = { focused: null as number | null }
  const renderer = { getFocusedElementId: () => state.focused }
  const remove = installElementSource(renderer, (id) => elements[id])
  return { renderer, state, remove }
}

describe("document.activeElement across roots", () => {
  it("is body with no root, and with a root that focuses nothing", () => {
    expect(document.activeElement).toBe(document.body)
    const only = root({ 1: {} })
    expect(document.activeElement).toBe(document.body)
    only.remove()
  })

  it("is the focused element's object", () => {
    const element = {}
    const only = root({ 1: element })
    only.state.focused = 1
    expect(document.activeElement).toBe(element)
    only.remove()
    expect(document.activeElement).toBe(document.body)
  })

  it("is the element of the window's own root: a window never answers with another's focus", () => {
    const a = {}
    const b = {}
    const first = root({ 1: a })
    const second = root({ 1: b })
    const firstDocument = documentOf(first.renderer as never)
    const secondDocument = documentOf(second.renderer as never)
    expect(firstDocument).toBe(document)
    expect(secondDocument).not.toBe(document)
    first.state.focused = 1
    second.state.focused = 1
    expect(firstDocument.activeElement).toBe(a)
    expect(secondDocument.activeElement).toBe(b)
    first.state.focused = null
    expect(firstDocument.activeElement).toBe(firstDocument.body)
    expect(secondDocument.activeElement).toBe(b)
    first.remove()
    second.remove()
  })

  it("has the focus in the window that heard a focus event last, among open windows", () => {
    const first = root({ 1: {} })
    const second = root({ 1: {} })
    const firstDocument = documentOf(first.renderer as never)
    const secondDocument = documentOf(second.renderer as never)
    expect([firstDocument.hasFocus(), secondDocument.hasFocus()]).toEqual([true, false])
    noteFocusEvent(second.renderer)
    expect([firstDocument.hasFocus(), secondDocument.hasFocus()]).toEqual([false, true])
    noteFocusEvent(first.renderer)
    expect([firstDocument.hasFocus(), secondDocument.hasFocus()]).toEqual([true, false])
    forgetWindowSource(first.renderer)
    expect([firstDocument.hasFocus(), secondDocument.hasFocus()]).toEqual([false, true])
    first.remove()
    second.remove()
    forgetElementSource(first.renderer)
  })

  it("throws when the root has no element for the focused id", () => {
    const only = root({})
    only.state.focused = 7
    expect(() => document.activeElement).toThrow("Element 7")
    only.remove()
  })

  it("lists no renderer that cannot report focus", () => {
    const remove = installElementSource({}, () => ({}))
    expect(document.activeElement).toBe(document.body)
    remove()
  })

  it("keeps naming elements for events after its window was taken over, but stops reporting focus", () => {
    const element = {}
    const only = root({ 1: element })
    only.state.focused = 1
    forgetWindowSource(only.renderer)
    expect(document.activeElement).toBe(document.body)
    expect(elementOf(only.renderer, 1)).toBe(element)
    only.remove()
    forgetElementSource(only.renderer)
    expect(() => elementOf(only.renderer, 1)).toThrow("No element source")
  })
})

describe("document.pointerLockElement", () => {
  it("is the object of the element the renderer reports as locked, and null otherwise", () => {
    const element = {}
    const state = { locked: null as number | null }
    const remove = installElementSource({ pointerLockElement: () => state.locked }, (id) =>
      id === 4 ? element : undefined
    )
    expect(document.pointerLockElement).toBeNull()
    state.locked = 4
    expect(document.pointerLockElement).toBe(element)
    state.locked = 9
    expect(() => document.pointerLockElement).toThrow(/Element 9 holds the pointer lock/)
    remove()
    expect(document.pointerLockElement).toBeNull()
  })

  it("is null for a renderer that cannot lock", () => {
    const remove = installElementSource({}, () => ({}))
    expect(document.pointerLockElement).toBeNull()
    remove()
  })
})
