/**
 * `element.animate()` against the native test renderer, below the adapters: what `ElementMethods.animate`
 * makes of keyframes and options, the engine that samples them, and the promises and events of the
 * `Animation` it returns, as `@dnd-kit/dom` uses them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { EventPayload } from "../../index.js"
import { createElementMethods } from "../host-runtime.js"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"
import { deliverWebAnimationEvent, isWebAnimationEvent, type Animation } from "../web-animations.js"
import type { NativeRenderer } from "../host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const BOX = 2

describeNative("element.animate()", () => {
  let renderer: TestRenderer
  const target = {}

  const host = () => renderer as unknown as NativeRenderer
  const animate = (keyframes: Parameters<ReturnType<typeof createElementMethods>["animate"]>[0], options?: Parameters<ReturnType<typeof createElementMethods>["animate"]>[1]) =>
    createElementMethods(host(), BOX).animate.call(target, keyframes, options)
  const getAnimations = () => createElementMethods(host(), BOX).getAnimations.call(target)

  const computed = (property: string) => {
    const pairs = renderer.getComputedStyle(BOX, false)!
    return pairs[pairs.indexOf(property) + 1]
  }

  const frame = (milliseconds: number) => {
    renderer.clockFastForward(milliseconds)
    renderer.drawFrame()
    renderer.dispatchNativeEvents()
  }

  beforeEach(() => {
    renderer = new TestRenderer({
      width: 200,
      height: 200,
      dispatchEvent: (event: EventPayload) => {
        if (isWebAnimationEvent(event.eventType)) deliverWebAnimationEvent(host(), event)
      },
    })
    renderer.clockPause()
    renderer.applyBatch(
      encodeWireBatchForTest([
        ["createElement", 1, "div"],
        ["setRoot", 1],
        ["setStyle", 1, { width: 100, height: 100 }],
        ["createElement", BOX, "div"],
        ["appendChild", 1, BOX],
        ["setStyle", BOX, { width: 40, height: 40 }],
      ])
    )
    renderer.flush()
    renderer.setInlineDraws(false)
    renderer.drawFrame()
  })

  afterEach(() => {
    renderer.dispose()
  })

  it("shows the in-between value of a property-indexed keyframe set and lists the animation", () => {
    const animation = animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 1000, easing: "linear" })
    expect(animation.effect.target).toBe(target)
    frame(0)
    frame(500)
    expect(computed("translate")).toBe("50px 0px")
    expect(animation.playState).toBe("running")
    expect(getAnimations()).toEqual([animation])
    expect(getAnimations()[0]).toBe(animation)
    frame(250)
    expect(computed("translate")).toBe("75px 0px")
  })

  it("takes the array form and a number as the duration", () => {
    animate([{ opacity: 0 }, { offset: 0.5, opacity: 1 }, { opacity: 0.5 }], 1000)
    frame(0)
    frame(250)
    expect(computed("opacity")).toBe("0.5")
    frame(250)
    expect(computed("opacity")).toBe("1")
  })

  it("resolves finished and removes the effect when it ends with no fill", async () => {
    const animation = animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 100 })
    frame(0)
    frame(200)
    await expect(animation.finished).resolves.toBe(animation)
    expect(animation.playState).toBe("finished")
    expect(computed("translate")).toBe("none")
    expect(getAnimations()).toEqual([])
  })

  it("holds the end value with fill forwards", async () => {
    const animation = animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 100, fill: "forwards" })
    frame(0)
    frame(500)
    await animation.finished
    expect(computed("translate")).toBe("100px 0px")
    expect(getAnimations()).toEqual([animation])
  })

  it("finish() jumps to the end and resolves finished", async () => {
    const animation = animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 100000, fill: "forwards" })
    frame(0)
    frame(16)
    animation.finish()
    frame(16)
    await expect(animation.finished).resolves.toBe(animation)
    expect(computed("translate")).toBe("100px 0px")
  })

  it("pause() holds the value while time passes", () => {
    const animation = animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 1000 })
    frame(0)
    frame(250)
    animation.pause()
    frame(16)
    frame(5000)
    expect(animation.playState).toBe("paused")
    expect(computed("translate")).toBe("25px 0px")
  })

  it("cancel() rejects finished with an AbortError and removes the effect", async () => {
    const animation = animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 1000 })
    frame(0)
    frame(250)
    const finished = animation.finished
    animation.cancel()
    frame(16)
    const error = await finished.then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect((error as DOMException).name).toBe("AbortError")
    expect(animation.playState).toBe("idle")
    expect(computed("translate")).toBe("none")
    expect(getAnimations()).toEqual([])
  })

  it("is what dnd-kit does: cancel what runs, then animate and await it", async () => {
    animate({ translate: ["0px 0px", "10px 0px"] }, { duration: 1000, fill: "forwards" })
    frame(0)
    getAnimations().forEach((running: Animation) => running.cancel())
    const animation = animate({ translate: ["0px 0px", "60px 0px"] }, { duration: 200, easing: "linear" })
    frame(0)
    frame(100)
    expect(computed("translate")).toBe("30px 0px")
    frame(200)
    await animation.finished
    expect(getAnimations()).toEqual([])
  })

  it("gives the id, timing and keyframes back", () => {
    const animation = animate([{ opacity: 0 }, { opacity: 1 }], { id: "fade", duration: 400, delay: 100, iterations: 2, fill: "both" })
    frame(0)
    expect(animation.id).toBe("fade")
    expect(animation.effect.getTiming()).toMatchObject({ duration: 400, delay: 100, iterations: 2, fill: "both", easing: "linear" })
    expect(animation.effect.getKeyframes().map((keyframe) => keyframe.opacity)).toEqual(["0", "1"])
  })

  it("leaves out what it cannot animate and throws a TypeError for a wrong timing, offset or easing", () => {
    expect(() => animate({ opacity: [0, 1] }, { duration: -1 })).toThrow(TypeError)
    expect(() => animate([{ offset: 2, opacity: 0 }], 100)).toThrow(TypeError)
    expect(() => animate([{ opacity: 0, easing: "wobble" }, { opacity: 1 }], 100)).toThrow(TypeError)
    const animation = animate({ nonsense: ["a", "b"], opacity: [0, 1] }, 100)
    frame(0)
    expect(animation.effect.getKeyframes().every((keyframe) => !("nonsense" in keyframe))).toBe(true)
  })
})
