/**
 * `element.animate()` on elements Solid renders, as `@dnd-kit/dom` uses it: cancel what runs, animate
 * `translate` with a duration and an easing, await `finished`, pause and finish.
 */
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { Animation } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("element.animate() in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot()
    app.renderer.clockPause()
  })

  afterEach(() => {
    app.unmount()
  })

  function mount(): HTMLElement {
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} style={{ width: 40, height: 40 }} />)
    app.renderer.clockFastForward(0)
    return box!
  }

  /** A box that transitions `translate`, which `setTranslate` changes as a signal does. */
  function mountTransitioning(): { box: HTMLElement; setTranslate: (value: string) => void } {
    let box: HTMLElement | undefined
    const [translate, setTranslate] = createSignal("none")
    app.render(() => (
      <div
        ref={(element) => (box = element as unknown as HTMLElement)}
        style={{ width: 40, height: 40, transition: "translate 1s linear", translate: translate() }}
      />
    ))
    app.renderer.clockFastForward(0)
    return { box: box!, setTranslate: (value) => app.flushSync(() => setTranslate(value)) }
  }

  const translate = (box: HTMLElement) => getComputedStyle(box).getPropertyValue("translate")
  const frame = (milliseconds: number) => {
    app.renderer.clockFastForward(milliseconds)
    app.renderer.dispatchNativeEvents()
  }

  it("animates a property-indexed keyframe set and shows the in-between value", () => {
    const box = mount()
    const animation = box.animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 1000, easing: "linear" })
    expect(animation).toBeInstanceOf(Animation)
    expect(animation.effect?.target).toBe(box)
    frame(0)
    frame(500)
    expect(translate(box)).toBe("50px")
    expect(animation.playState).toBe("running")
    expect(box.getAnimations()).toEqual([animation])
    frame(250)
    expect(translate(box)).toBe("75px")
  })

  it("takes the array form with offsets and a number as the duration", () => {
    const box = mount()
    box.animate([{ opacity: 0 }, { offset: 0.5, opacity: 1 }, { opacity: 0.5 }], 1000)
    frame(0)
    frame(250)
    expect(getComputedStyle(box).getPropertyValue("opacity")).toBe("0.5")
    frame(250)
    expect(getComputedStyle(box).getPropertyValue("opacity")).toBe("1")
  })

  it("resolves finished and drops the effect when it ends with no fill", async () => {
    const box = mount()
    const animation = box.animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 100 })
    frame(0)
    frame(200)
    await expect(animation.finished).resolves.toBe(animation)
    expect(animation.playState).toBe("finished")
    expect(translate(box)).toBe("none")
    expect(box.getAnimations()).toEqual([])
  })

  it("holds the end value with fill forwards", async () => {
    const box = mount()
    const animation = box.animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 100, fill: "forwards" })
    frame(0)
    frame(500)
    await animation.finished
    expect(translate(box)).toBe("100px")
    expect(box.getAnimations()).toEqual([animation])
  })

  it("finish() jumps to the end and resolves finished", async () => {
    const box = mount()
    const animation = box.animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 100000, fill: "forwards" })
    frame(0)
    frame(16)
    animation.finish()
    frame(16)
    await expect(animation.finished).resolves.toBe(animation)
    expect(translate(box)).toBe("100px")
  })

  it("pause() holds the value while time passes", () => {
    const box = mount()
    const animation = box.animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 1000 })
    frame(0)
    frame(250)
    animation.pause()
    frame(16)
    frame(5000)
    expect(animation.playState).toBe("paused")
    expect(translate(box)).toBe("25px")
  })

  it("cancel() rejects finished with an AbortError and removes the effect", async () => {
    const box = mount()
    const animation = box.animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 1000 })
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
    expect(translate(box)).toBe("none")
    expect(box.getAnimations()).toEqual([])
  })

  it("is what dnd-kit does: cancel what runs, then animate and await it", async () => {
    const box = mount()
    box.animate({ translate: ["0px 0px", "10px 0px"] }, { duration: 1000, fill: "forwards" })
    frame(0)
    box.getAnimations().forEach((running) => running.cancel())
    const animation = box.animate({ translate: ["0px 0px", "60px 0px"] }, { duration: 200, easing: "linear" })
    frame(0)
    frame(100)
    expect(translate(box)).toBe("30px")
    frame(200)
    await animation.finished
    expect(box.getAnimations()).toEqual([])
  })

  it("gives the animation its id, timing and keyframes back", () => {
    const box = mount()
    const animation = box.animate([{ opacity: 0 }, { opacity: 1 }], { id: "fade", duration: 400, delay: 100, iterations: 2, fill: "both" })
    frame(0)
    expect(animation.id).toBe("fade")
    expect(animation.effect?.getTiming()).toMatchObject({ duration: 400, delay: 100, iterations: 2, fill: "both", easing: "linear" })
    expect(animation.effect?.getKeyframes().map((keyframe) => keyframe.opacity)).toEqual(["0", "1"])
  })

  it("leaves out what it cannot animate and throws a TypeError for a wrong timing or offset", () => {
    const box = mount()
    expect(() => box.animate({ opacity: [0, 1] }, { duration: -1 })).toThrow(TypeError)
    expect(() => box.animate([{ offset: 2, opacity: 0 }], 100)).toThrow(TypeError)
    expect(() => box.animate([{ opacity: 0, easing: "wobble" }, { opacity: 1 }], 100)).toThrow(TypeError)
    const animation = box.animate({ nonsense: ["a", "b"], opacity: [0, 1] }, 100)
    expect(animation.effect?.getKeyframes().every((keyframe) => !("nonsense" in keyframe))).toBe(true)
  })


  it("answers getKeyframes() of a script animation at once, as the DOM does", () => {
    const box = mount()
    const animation = box.animate([{ translate: "0px 0px" }, { translate: "10px 20px" }], 200)
    expect(animation.effect?.getKeyframes()).toEqual([
      { offset: null, computedOffset: 0, easing: "linear", composite: "auto", translate: "0px" },
      { offset: null, computedOffset: 1, easing: "linear", composite: "auto", translate: "10px 20px" },
    ])
    const given = box.animate({ translate: ["1px 2px 0", "3px 4px 5px"], offset: [0, 1] }, 200)
    expect(given.effect?.getKeyframes().map((keyframe) => [keyframe.offset, keyframe.computedOffset, keyframe.translate])).toEqual([
      [0, 0, "1px 2px"],
      [1, 1, "3px 4px 5px"],
    ])
  })

  it("answers getKeyframes() of a translate transition that was retargeted while it ran", () => {
    const { box, setTranslate } = mountTransitioning()
    setTranslate("10px 20px 0")
    frame(0)
    frame(100)
    setTranslate("50px 60px 0")
    frame(0)
    frame(100)
    const [transition] = box.getAnimations()
    expect(transition?.effect?.getKeyframes().map((keyframe) => keyframe.translate)).toEqual(["1px 2px", "50px 60px"])
  })

  async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    app.renderer.flush()
  }

  it("leaves a script animation running when its element is removed, and finished resolves on time", async () => {
    const box = mount()
    const animation = box.animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 1000, easing: "linear" })
    const rejected = vi.fn()
    animation.finished.catch(rejected)
    frame(0)
    frame(250)
    box.remove()
    await settle()
    frame(0)
    frame(250)
    expect(animation.playState).toBe("running")
    expect(animation.currentTime).toBe(500)
    expect(box.getAnimations()).toEqual([animation])
    frame(600)
    await expect(animation.finished).resolves.toBe(animation)
    expect(animation.playState).toBe("finished")
    expect(rejected).not.toHaveBeenCalled()
  })

  it("shows a script animation of an element that is inserted again where the clock took it", async () => {
    const box = mount()
    const animation = box.animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 1000, easing: "linear" })
    frame(0)
    frame(250)
    box.remove()
    await settle()
    frame(0)
    frame(250)
    document.body!.appendChild(box)
    await settle()
    frame(0)
    expect(animation.playState).toBe("running")
    expect(translate(box)).toBe("50px")
    frame(250)
    expect(translate(box)).toBe("75px")
    expect(box.getAnimations()).toEqual([animation])
    frame(500)
    await expect(animation.finished).resolves.toBe(animation)
  })

  it("still cancels the CSS animations of an element that is removed", async () => {
    const { box, setTranslate } = mountTransitioning()
    setTranslate("100px 20px 0")
    frame(0)
    frame(100)
    const [transition] = box.getAnimations()
    expect(transition?.playState).toBe("running")
    box.remove()
    await settle()
    frame(0)
    expect(transition?.playState).toBe("idle")
  })
})
