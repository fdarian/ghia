import { describe, expect, it } from "vitest"
import { HOST_BINDING } from "../bounds.js"
import { COMPUTED_STYLE_PROPERTIES, getComputedStyle, invalidateComputedStyles } from "../computed-style.js"
import { requiredWriter } from "../dom/renderer-writer.js"
import type { MutationRenderer, NativeRenderer } from "../host.js"
import { MouseEvent } from "../events/classes.js"
import { activateAfterClick, preActivateClick } from "../events/activation.js"
import { createElementMethods } from "../host-runtime.js"

function fakeElement(id: number, pairs: string[] | null, mounted = true) {
  const reads: [number, boolean][] = []
  const renderer = {
    applyBatch: () => [],
    getComputedStyle(elementId: number, pseudo: boolean) {
      reads.push([elementId, pseudo])
      return pairs
    },
  } as unknown as NativeRenderer
  const element = {
    nativeId: id,
    [HOST_BINDING]: () => (mounted ? { renderer, mutations: {} as MutationRenderer } : undefined),
  }
  return { element, reads }
}

describe("getComputedStyle", () => {
  it("reads camelCase members and kebab-case names from one native record", async () => {
    const fake = fakeElement(3, ["font-size", "20px", "padding-inline-start", "4px", "--gap", "12px"])
    const element = fake.element
    const reads = fake.reads
    const style = getComputedStyle(element)
    expect([style.fontSize, style.paddingInlineStart, style.getPropertyValue("font-size"), style.getPropertyValue("--gap")]).toEqual([
      "20px",
      "4px",
      "20px",
      "12px",
    ])
    expect(style.getPropertyValue("--missing")).toBe("")
    expect(style.width).toBe("")
    expect(reads).toEqual([[3, false]])
    await Promise.resolve()
    expect(style.fontSize).toBe("20px")
    expect(reads).toHaveLength(2)
  })

  it("keeps no entry past the turn it was read in", async () => {
    const fake = fakeElement(3, ["font-size", "20px"])
    const element = fake.element
    const reads = fake.reads
    const style = getComputedStyle(element)
    expect(style.fontSize).toBe("20px")
    expect(style.fontSize).toBe("20px")
    expect(reads).toHaveLength(1)
    await Promise.resolve()
    expect(style.fontSize).toBe("20px")
    expect(reads).toHaveLength(2)
  })

  it("reads again in the same turn after time moved or a frame was drawn", () => {
    let opacity = "0"
    const renderer = {
      applyBatch: () => [],
      getComputedStyle: () => ["opacity", opacity],
    } as unknown as NativeRenderer
    const element = {
      nativeId: 3,
      [HOST_BINDING]: () => ({ renderer, mutations: {} as MutationRenderer }),
    }
    const style = getComputedStyle(element)
    expect(style.opacity).toBe("0")
    opacity = "0.5"
    expect(style.opacity, "nothing happened in between: the kept answer stands").toBe("0")
    invalidateComputedStyles()
    expect(style.opacity).toBe("0.5")
  })

  it("asks for an absent pseudo-element for ::before and ::after, and reads empty for any other", () => {
    const fake = fakeElement(3, ["content", "none"])
    const element = fake.element
    const reads = fake.reads
    expect(getComputedStyle(element, "::before").content).toBe("none")
    expect(getComputedStyle(element, ":after").content).toBe("none")
    expect(getComputedStyle(element, "::marker").content).toBe("")
    expect(reads).toEqual([[3, true]])
  })

  it("reads empty for an element that is not mounted or not in the document", () => {
    const unmounted = fakeElement(3, ["display", "block"], false)
    expect(getComputedStyle(unmounted.element).display).toBe("")
    expect(unmounted.reads).toEqual([])
    const detached = fakeElement(3, null)
    expect(getComputedStyle(detached.element).display).toBe("")
  })

  it("throws for what is not an element, and for a write", () => {
    expect(() => getComputedStyle({} as never)).toThrow(TypeError)
    const element = fakeElement(3, []).element
    expect(() => getComputedStyle(element).setProperty("width", "1px")).toThrow(
      expect.objectContaining({ name: "NoModificationAllowedError" })
    )
    expect(getComputedStyle(element).length).toBe(COMPUTED_STYLE_PROPERTIES.length)
  })

  describe("after a native change that restyles with no batch", () => {
    /** A renderer whose padding follows a checked flag that each of the native calls changes. */
    function checkable() {
      let checked = false
      const flip = () => {
        checked = !checked
      }
      const renderer = {
        applyBatch: () => [],
        getComputedStyle: () => ["padding-top", checked ? "7px" : "0px"],
        clickElement: flip,
        preActivateElement: flip,
        activateElement: flip,
        cancelActivation: flip,
        writeInputFlag: flip,
        restoreControlledState: flip,
      } as unknown as NativeRenderer
      const element = {
        nativeId: 3,
        [HOST_BINDING]: () => ({ renderer, mutations: {} as MutationRenderer }),
      }
      return { renderer, style: getComputedStyle(element) }
    }

    it("reads the new style in the same turn, for each call the DOM members make", () => {
      const click = new MouseEvent("click")
      const calls: [string, (renderer: NativeRenderer) => void][] = [
        ["element.click()", (renderer) => createElementMethods(renderer, 3).click()],
        ["the toggle before a click", (renderer) => preActivateClick({ renderer, id: 3 }, click)],
        ["the activation after a click", (renderer) => activateAfterClick({ renderer, id: 3 }, click)],
        ["a canceled click", (renderer) => {
          const canceled = new MouseEvent("click", { cancelable: true })
          canceled.preventDefault()
          activateAfterClick({ renderer, id: 3 }, canceled)
        }],
        ["a script write", (renderer) => requiredWriter(renderer, "writeInputFlag", "")(3, "checked", true)],
        ["a restore", (renderer) => requiredWriter(renderer, "restoreControlledState", "")(3)],
      ]
      for (const [name, call] of calls) {
        const fake = checkable()
        expect(fake.style.paddingTop, name).toBe("0px")
        call(fake.renderer)
        expect(fake.style.paddingTop, name).toBe("7px")
      }
    })

    it("ends the kept styles when the native call throws", () => {
      const fake = checkable()
      expect(fake.style.paddingTop).toBe("0px")
      const renderer = fake.renderer as unknown as { writeInputFlag: () => void }
      const flip = renderer.writeInputFlag
      renderer.writeInputFlag = () => {
        flip()
        throw new Error("native failed")
      }
      expect(() => requiredWriter(fake.renderer, "writeInputFlag", "")(3, "checked", true)).toThrow("native failed")
      expect(fake.style.paddingTop).toBe("7px")
    })
  })
})
