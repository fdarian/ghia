/** The slots an adapter's `render()` keeps for each renderer it mounts on, shared by both adapters. */
import { afterEach, describe, expect, it } from "vitest"
import "../dom-globals.js"
import { bindRenderSlot, ownRenderer, ownRenderSlot, renderSlotFor, renderSlots, resetRenderSlots } from "../render-hosts.js"
import { TestRenderer, hasNativeTestRenderer } from "../testing.js"
import { windowGone } from "../window-lifecycle.js"

afterEach(() => resetRenderSlots())

describe.skipIf(!hasNativeTestRenderer)("render slots", () => {
  it("gives one slot to each renderer a render is given, and one own slot to the renders that name none", () => {
    const renderer = new TestRenderer({ width: 100, height: 100 })
    const given = renderSlotFor(renderer)
    expect(given.renderer).toBe(renderer)
    expect(renderSlotFor(renderer)).toBe(given)
    const own = renderSlotFor(undefined)
    expect(renderSlotFor(undefined)).toBe(own)
    expect(own).not.toBe(given)
    expect(renderSlots()).toEqual([given, own])
    expect(ownRenderSlot()).toBe(own)
    expect(ownRenderer()).toBeUndefined()
    renderer.dispose()
  })

  it("drops the slot of a renderer that is disposed", () => {
    const renderer = new TestRenderer({ width: 100, height: 100 })
    renderSlotFor(renderer)
    const kept = new TestRenderer({ width: 100, height: 100 })
    const keptSlot = renderSlotFor(kept)
    expect(renderSlots()).toHaveLength(2)
    renderer.dispose()
    expect(renderSlots()).toEqual([keptSlot])
    kept.dispose()
    expect(renderSlots()).toEqual([])
  })

  it("drops the own slot when its window is gone, so the next render makes a window again", () => {
    const renderer = new TestRenderer({ width: 100, height: 100 })
    const own = renderSlotFor(undefined)
    bindRenderSlot(own, renderer)
    expect(ownRenderer()).toBe(renderer)
    windowGone(renderer)
    expect(ownRenderSlot()).toBeUndefined()
    expect(ownRenderer()).toBeUndefined()
    expect(renderSlots()).toEqual([])
    expect(renderSlotFor(undefined)).not.toBe(own)
    renderer.dispose()
  })

  it("stops the loops and unmounts the roots of every slot on reset, and forgets the slots", () => {
    const log: string[] = []
    const first = renderSlotFor<{ renderer?: TestRenderer; root?: { unmount(): void }; loop?: { stop(): void } }>(undefined)
    first.loop = { stop: () => log.push("stop own") }
    first.root = { unmount: () => log.push("unmount own") }
    const renderer = new TestRenderer({ width: 100, height: 100 })
    const second = renderSlotFor(renderer)
    second.root = { unmount: () => log.push("unmount given") }
    resetRenderSlots()
    expect(log).toEqual(["stop own", "unmount own", "unmount given"])
    expect(renderSlots()).toEqual([])
    renderer.dispose()
  })

  it("unmounts the other roots even when one loop fails to stop", () => {
    const first = renderSlotFor(undefined)
    first.loop = {
      stop() {
        throw new Error("stuck")
      },
    }
    const unmounted: string[] = []
    first.root = { unmount: () => unmounted.push("own") }
    expect(() => resetRenderSlots()).toThrow("stuck")
    expect(unmounted).toEqual(["own"])
  })
})
