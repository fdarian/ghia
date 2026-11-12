/**
 * `element.animate()` against the native test renderer, below the adapters: what `ElementMethods.animate`
 * makes of keyframes and options, the engine that samples them, and the promises and events of the
 * `Animation` it returns, as `@dnd-kit/dom` uses them.
 */
import v8 from "node:v8"
import vm from "node:vm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { EventPayload } from "../../index.js"
import { createElementMethods } from "../host-runtime.js"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"
import { cancelAnimationsOfElements, deliverWebAnimationEvent, isWebAnimationEvent, type Animation } from "../web-animations.js"
import type { NativeRenderer } from "../host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

v8.setFlagsFromString("--expose-gc")
const collect = vm.runInNewContext("gc") as () => void

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
    expect(computed("translate")).toBe("50px")
    expect(animation.playState).toBe("running")
    expect(getAnimations()).toEqual([animation])
    expect(getAnimations()[0]).toBe(animation)
    frame(250)
    expect(computed("translate")).toBe("75px")
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
    expect(computed("translate")).toBe("100px")
    expect(getAnimations()).toEqual([animation])
  })

  it("finish() jumps to the end and resolves finished", async () => {
    const animation = animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 100000, fill: "forwards" })
    frame(0)
    frame(16)
    animation.finish()
    frame(16)
    await expect(animation.finished).resolves.toBe(animation)
    expect(computed("translate")).toBe("100px")
  })

  it("pause() holds the value while time passes", () => {
    const animation = animate({ translate: ["0px 0px", "100px 0px"] }, { duration: 1000 })
    frame(0)
    frame(250)
    animation.pause()
    frame(16)
    frame(5000)
    expect(animation.playState).toBe("paused")
    expect(computed("translate")).toBe("25px")
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
    expect(computed("translate")).toBe("30px")
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

  it("lets native drop the run of a script animation that was cancelled on a connected element once the app lets go", async () => {
    const known = (id: number) => {
      try {
        renderer.getAnimation(id)
        return true
      } catch {
        return false
      }
    }
    const run = () => {
      const animation = animate({ opacity: [0, 1] }, 1000)
      frame(0)
      const id = renderer.getAnimations(BOX)[0].id
      animation.cancel()
      frame(16)
      return id
    }
    const id = run()
    for (let round = 0; round < 20 && known(id); round++) {
      collect()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(known(id)).toBe(false)
  })
})


describeNative("element.animate() on an element that is removed", () => {
  let renderer: TestRenderer

  const host = () => renderer as unknown as NativeRenderer
  const methods = () => createElementMethods(host(), BOX)

  const frame = (milliseconds: number) => {
    renderer.clockFastForward(milliseconds)
    renderer.drawFrame()
    renderer.dispatchNativeEvents()
  }

  /** What the mutation queue does with a batch that removes the box: native destroys it, JS is told which. */
  const remove = (sweep = true) => {
    const destroyed = renderer.applyBatch(
      encodeWireBatchForTest([
        ["detachChild", 1, BOX],
        ["destroyElement", BOX],
      ])
    )
    cancelAnimationsOfElements(host(), destroyed)
    renderer.flush()
    if (sweep) frame(0)
  }

  const insertAgain = () => {
    renderer.applyBatch(
      encodeWireBatchForTest([
        ["createElement", BOX, "div"],
        ["appendChild", 1, BOX],
        ["setStyle", BOX, { width: 40, height: 40 }],
      ])
    )
    renderer.flush()
    frame(0)
  }

  const known = (id: number) => {
    try {
      renderer.getAnimation(id)
      return true
    } catch {
      return false
    }
  }

  const collectUntil = async (done: () => boolean) => {
    for (let round = 0; round < 20 && !done(); round++) {
      collect()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
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

  it("lists nothing while it is out of the tree, and lists a finished animation that fills again when it is back", async () => {
    const target = {}
    const animation = methods().animate.call(target, { opacity: [0, 1] }, { duration: 200, fill: "forwards" })
    frame(0)
    frame(100)
    remove()
    expect(methods().getAnimations.call(target)).toEqual([])
    frame(300)
    await expect(animation.finished).resolves.toBe(animation)
    insertAgain()
    expect(methods().getAnimations.call(target)).toEqual([animation])
  })

  it("plays an animation again that was cancelled after the element was removed", async () => {
    const target = {}
    const animation = methods().animate.call(target, { opacity: [0, 1] }, 1000)
    frame(0)
    frame(100)
    remove()
    animation.cancel()
    frame(16)
    expect(animation.playState).toBe("idle")
    animation.play()
    frame(16)
    expect(animation.playState).toBe("running")
    frame(1100)
    await expect(animation.finished).resolves.toBe(animation)
  })

  it("plays an animation again that was cancelled before the frame that sweeps its removed element", async () => {
    const target = {}
    const animation = methods().animate.call(target, { opacity: [0, 1] }, 1000)
    frame(0)
    frame(100)
    remove(false)
    animation.cancel()
    frame(16)
    expect(animation.playState).toBe("idle")
    animation.play()
    frame(16)
    expect(animation.playState).toBe("running")
    frame(1100)
    await expect(animation.finished).resolves.toBe(animation)
  })

  it("plays an animation again that was cancelled before its element was removed", () => {
    const target = {}
    const animation = methods().animate.call(target, { opacity: [0, 1] }, 1000)
    frame(0)
    animation.cancel()
    frame(16)
    remove()
    animation.play()
    frame(16)
    expect(animation.playState).toBe("running")
  })

  it("keeps a running animation and its run when the app lets go of everything", async () => {
    const run = () => {
      methods().animate.call({}, { opacity: [0, 1] }, 1000)
      frame(0)
      return renderer.getAnimations(BOX)[0].id
    }
    const id = run()
    remove()
    await collectUntil(() => !known(id))
    expect(known(id)).toBe(true)
    frame(1100)
    expect(renderer.getAnimation(id).playState).toBe("finished")
  })

  it("lets native drop the run of a finished animation that fills once the element and the animation are gone", async () => {
    const run = () => {
      methods().animate.call({}, { opacity: [0, 1] }, { duration: 100, fill: "both" })
      frame(0)
      const id = renderer.getAnimations(BOX)[0].id
      remove()
      frame(200)
      return id
    }
    const id = run()
    await collectUntil(() => !known(id))
    expect(known(id)).toBe(false)
  })

  it("keeps the run of a finished animation that fills as long as the element is held", async () => {
    const target = {}
    const id = (() => {
      methods().animate.call(target, { opacity: [0, 1] }, { duration: 100, fill: "both" })
      frame(0)
      const made = renderer.getAnimations(BOX)[0].id
      remove()
      frame(200)
      return made
    })()
    await collectUntil(() => !known(id))
    expect(known(id)).toBe(true)
    insertAgain()
    expect(methods().getAnimations.call(target).map((animation) => animation.playState)).toEqual(["finished"])
    expect(target).toBeDefined()
  })

  it("keeps an orphan that was cancelled and played again before the cancel event arrived", async () => {
    const run = () => {
      const animation = methods().animate.call({}, { opacity: [0, 1] }, 1000)
      frame(0)
      const id = renderer.getAnimations(BOX)[0].id
      remove()
      animation.cancel()
      animation.play()
      return { id, finished: animation.finished }
    }
    const made = run()
    frame(16)
    await collectUntil(() => !known(made.id))
    expect(known(made.id)).toBe(true)
    frame(1100)
    await expect(made.finished).resolves.toBeDefined()
  })

  it("lets native drop the run of an orphan that a command left idle", async () => {
    const run = () => {
      const animation = methods().animate.call({}, { opacity: [0, 1] }, 1000)
      frame(0)
      const id = renderer.getAnimations(BOX)[0].id
      remove()
      animation.cancel()
      frame(16)
      animation.effect?.updateTiming({ delay: 10 })
      return id
    }
    const id = run()
    await collectUntil(() => !known(id))
    expect(known(id)).toBe(false)
  })

  describe("what holds an animation the app dropped", () => {
    const settle = async () => {
      for (let round = 0; round < 3; round++) {
        collect()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    it("tells the onfinish of an animation that finished after its element was removed", async () => {
      const fired: string[] = []
      ;(() => {
        const animation = methods().animate.call({}, { opacity: [0, 1] }, 1000)
        frame(0)
        animation.onfinish = () => fired.push("finish")
        remove()
        animation.finish()
      })()
      await settle()
      frame(16)
      expect(fired).toEqual(["finish"])
    })

    it("tells the oncancel of an animation cancelled after its element was removed and given a timing", async () => {
      const fired: string[] = []
      ;(() => {
        const animation = methods().animate.call({}, { opacity: [0, 1] }, 1000)
        frame(0)
        animation.oncancel = () => fired.push("cancel")
        remove()
        animation.cancel()
        animation.effect.updateTiming({ delay: 10 })
      })()
      await settle()
      frame(16)
      expect(fired).toEqual(["cancel"])
    })

    it("tells the oncancel of an animation cancelled and removed in one flush", async () => {
      const fired: string[] = []
      ;(() => {
        const animation = methods().animate.call({}, { opacity: [0, 1] }, 1000)
        frame(0)
        animation.oncancel = () => fired.push("cancel")
        animation.cancel()
        remove(false)
      })()
      await settle()
      frame(16)
      expect(fired).toEqual(["cancel"])
    })

    it("lists an animation that was cancelled, removed, played and finished with a fill when the element is back", async () => {
      const target = {}
      ;(() => {
        const animation = methods().animate.call(target, { opacity: [0, 1] }, { duration: 100, fill: "both" })
        frame(0)
        animation.cancel()
        frame(16)
        remove()
        animation.play()
        frame(16)
        frame(200)
      })()
      await settle()
      insertAgain()
      expect(methods().getAnimations.call(target).map((listed) => listed.playState)).toEqual(["finished"])
    })

    it("lets native drop the run of an orphan that was cancelled, given a timing and let go of", async () => {
      const id = (() => {
        const animation = methods().animate.call({}, { opacity: [0, 1] }, 1000)
        frame(0)
        const made = renderer.getAnimations(BOX)[0].id
        animation.cancel()
        frame(16)
        remove()
        animation.effect.updateTiming({ delay: 10 })
        return made
      })()
      await collectUntil(() => !known(id))
      expect(known(id)).toBe(false)
    })

    it("lets native drop the run of an animation cancelled on a connected element and then given a timing and a rate", async () => {
      const id = (() => {
        const animation = methods().animate.call({}, { opacity: [0, 1] }, 1000)
        frame(0)
        const made = renderer.getAnimations(BOX)[0].id
        animation.cancel()
        frame(16)
        animation.effect.updateTiming({ delay: 10 })
        animation.playbackRate = 2
        return made
      })()
      await collectUntil(() => !known(id))
      expect(known(id)).toBe(false)
    })

    it("lets native drop the run of an orphan held by its element that was played and cancelled, while the element lives", async () => {
      const target = {}
      const id = (() => {
        const animation = methods().animate.call(target, { opacity: [0, 1] }, { duration: 100, fill: "both" })
        frame(0)
        const made = renderer.getAnimations(BOX)[0].id
        remove()
        frame(200)
        animation.play()
        animation.cancel()
        frame(16)
        return made
      })()
      await collectUntil(() => !known(id))
      expect(known(id)).toBe(false)
      expect(target).toBeDefined()
    })
  })
})
