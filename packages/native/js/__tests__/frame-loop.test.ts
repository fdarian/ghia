import { describe, expect, it } from "vitest"
import { startFrameLoop } from "../runtime.js"

const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve))

const wakeableRenderer = (tick: () => boolean) => {
  const renderer = {
    wake: null as (() => unknown) | null,
    requiresTick: () => true,
    setFrameWakeCallback: (callback?: (() => unknown) | null) => {
      renderer.wake = callback ?? null
      return true
    },
    tick,
  }
  return renderer
}

describe("startFrameLoop on a platform with display-link wakes", () => {
  it("ticks once at start and then on every wake", async () => {
    let ticks = 0
    const renderer = wakeableRenderer(() => {
      ticks += 1
      return true
    })
    const loop = startFrameLoop(renderer)
    expect(ticks).toBe(1)
    renderer.wake?.()
    expect(ticks).toBe(1)
    await nextImmediate()
    expect(ticks).toBe(2)
    renderer.wake?.()
    await nextImmediate()
    expect(ticks).toBe(3)
    loop.stop()
    expect(renderer.wake).toBeNull()
  })

  it("ticks once for several wakes fired before the immediate runs", async () => {
    let ticks = 0
    const renderer = wakeableRenderer(() => {
      ticks += 1
      return true
    })
    const loop = startFrameLoop(renderer)
    renderer.wake?.()
    renderer.wake?.()
    renderer.wake?.()
    await nextImmediate()
    expect(ticks).toBe(2)
    loop.stop()
  })

  it("does not tick for a wake that is still scheduled when the loop stops", async () => {
    let ticks = 0
    const renderer = wakeableRenderer(() => {
      ticks += 1
      return true
    })
    const loop = startFrameLoop(renderer)
    renderer.wake?.()
    loop.stop()
    await nextImmediate()
    expect(ticks).toBe(1)
  })

  it("arms no timer while idle: no wake, no tick", async () => {
    let ticks = 0
    const loop = startFrameLoop(
      wakeableRenderer(() => {
        ticks += 1
        return true
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    loop.stop()
    expect(ticks).toBe(1)
  })

  it("ticks once per wake and not in between", async () => {
    let ticks = 0
    const renderer = wakeableRenderer(() => {
      ticks += 1
      return true
    })
    const loop = startFrameLoop(renderer)
    const wakes = setInterval(() => renderer.wake?.(), 10)
    await new Promise((resolve) => setTimeout(resolve, 250))
    clearInterval(wakes)
    await nextImmediate()
    const ticksAtLastWake = ticks
    await new Promise((resolve) => setTimeout(resolve, 150))
    loop.stop()
    expect(ticks).toBe(ticksAtLastWake)
    expect(ticks).toBeLessThanOrEqual(Math.floor(250 / 10) + 2)
  })

  it("stops, clears the wake and reports termination when tick returns false", () => {
    let ticks = 0
    let terminated = 0
    const renderer = wakeableRenderer(() => {
      ticks += 1
      return false
    })
    startFrameLoop(renderer, { onTerminated: () => (terminated += 1) })
    expect(ticks).toBe(1)
    expect(terminated).toBe(1)
    expect(renderer.wake).toBeNull()
  })

  it("releases the sync event handler when the window closes", () => {
    const cleared: unknown[] = []
    const renderer = {
      ...wakeableRenderer(() => false),
      setSyncEventHandler: (handler: unknown) => cleared.push(handler),
    }
    startFrameLoop(renderer)
    expect(cleared).toEqual([null])
  })

  it("keeps the sync event handler while the loop is only stopped", () => {
    const cleared: unknown[] = []
    const renderer = {
      ...wakeableRenderer(() => true),
      setSyncEventHandler: (handler: unknown) => cleared.push(handler),
    }
    startFrameLoop(renderer).stop()
    expect(cleared).toEqual([])
  })

  it("reports tick errors and keeps running", async () => {
    const errors: unknown[] = []
    const renderer = wakeableRenderer(() => {
      throw new Error("boom")
    })
    const loop = startFrameLoop(renderer, { onError: (error) => errors.push(error) })
    renderer.wake?.()
    await nextImmediate()
    loop.stop()
    expect(errors.length).toBe(2)
  })

  it("keeps polling with a timer when frameMs is set", async () => {
    let ticks = 0
    const renderer = wakeableRenderer(() => {
      ticks += 1
      return true
    })
    const loop = startFrameLoop(renderer, { frameMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 25))
    loop.stop()
    expect(renderer.wake).toBeNull()
    expect(ticks).toBeGreaterThan(1)
    expect(ticks).toBeLessThanOrEqual(4)
  })
})

describe("startFrameLoop without display-link wakes", () => {
  it("polls with a timer when the renderer declines the wake callback", async () => {
    let ticks = 0
    const loop = startFrameLoop({
      requiresTick: () => true,
      setFrameWakeCallback: () => false,
      tick: () => {
        ticks += 1
        return true
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    loop.stop()
    expect(ticks).toBeGreaterThan(2)
  })

  it("polls with a timer", async () => {
    let ticks = 0
    const loop = startFrameLoop(
      {
        requiresTick: () => true,
        tick: () => {
          ticks += 1
          return true
        },
      },
      { frameMs: 10 },
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    loop.stop()
    expect(ticks).toBeGreaterThan(1)
  })

  it("ticks again with setImmediate, not the timer, while a key event is pending", async () => {
    let ticks = 0
    let pending = 3
    const loop = startFrameLoop(
      {
        requiresTick: () => true,
        tick: () => {
          ticks += 1
          return true
        },
        keyEventPending: () => {
          pending -= 1
          return pending >= 0
        },
      },
      { frameMs: 10_000 },
    )
    expect(ticks).toBe(1)
    for (let immediates = 0; immediates < 5; immediates++) await nextImmediate()
    loop.stop()
    expect(ticks).toBe(4)
  })

  it("draws the input frame from a setImmediate after the tick and its microtasks, once", async () => {
    const events: string[] = []
    let pending = true
    const renderer = {
      ...wakeableRenderer(() => {
        events.push("tick")
        queueMicrotask(() => events.push("microtask"))
        return true
      }),
      startedLinksPending: () => pending,
      stepStartedLinks: () => {
        events.push("frame")
        pending = false
        return true
      },
    }
    const loop = startFrameLoop(renderer)
    // The wake's tick runs after the frame call's immediate (it is scheduled behind it) and does not queue a second one.
    renderer.wake?.()
    await nextImmediate()
    await nextImmediate()
    loop.stop()
    expect(events.filter((event) => event === "frame")).toHaveLength(1)
    expect(events.slice(0, 3)).toEqual(["tick", "microtask", "frame"])
  })

  it("draws the input frame of a link only a microtask of the tick started", async () => {
    const events: string[] = []
    let pending = false
    const renderer = {
      ...wakeableRenderer(() => {
        events.push("tick")
        queueMicrotask(() => {
          events.push("microtask starts the link")
          pending = true
        })
        return true
      }),
      startedLinksPending: () => pending,
      stepStartedLinks: () => {
        events.push("frame")
        pending = false
        return true
      },
    }
    const loop = startFrameLoop(renderer)
    await nextImmediate()
    await nextImmediate()
    loop.stop()
    expect(events).toEqual(["tick", "microtask starts the link", "frame"])
  })

  it("makes no frame call when no link is waiting, and adds no tick", async () => {
    let ticks = 0
    let calls = 0
    const loop = startFrameLoop({
      ...wakeableRenderer(() => {
        ticks += 1
        return true
      }),
      startedLinksPending: () => false,
      stepStartedLinks: () => {
        calls += 1
        return false
      },
    })
    for (let immediates = 0; immediates < 3; immediates++) await nextImmediate()
    loop.stop()
    expect(calls).toBe(0)
    expect(ticks).toBe(1)
  })

  it("does not draw the input frame of a stopped loop", async () => {
    let ticks = 0
    let calls = 0
    let pending = 1
    const loop = startFrameLoop(
      {
        requiresTick: () => true,
        tick: () => {
          ticks += 1
          return true
        },
        keyEventPending: () => pending-- > 0,
        startedLinksPending: () => true,
        stepStartedLinks: () => {
          calls += 1
          return true
        },
      },
      { frameMs: 10_000 },
    )
    loop.stop()
    await nextImmediate()
    expect(calls).toBe(0)
    expect(ticks).toBe(1)
  })

  it("draws the input frame of a timer loop before the key's re-tick", async () => {
    const events: string[] = []
    let pending = 1
    const loop = startFrameLoop(
      {
        requiresTick: () => true,
        tick: () => {
          events.push("tick")
          return true
        },
        keyEventPending: () => pending-- > 0,
        startedLinksPending: () => events.length === 1,
        stepStartedLinks: () => {
          events.push("frame")
          return true
        },
      },
      { frameMs: 10_000 },
    )
    await nextImmediate()
    await nextImmediate()
    loop.stop()
    expect(events).toEqual(["tick", "frame", "tick"])
  })

  it("reports an error the frame call throws and keeps the loop", async () => {
    const errors: unknown[] = []
    const loop = startFrameLoop(
      {
        ...wakeableRenderer(() => true),
        startedLinksPending: () => true,
        stepStartedLinks: () => {
          throw new Error("refused")
        },
      },
      { onError: (error) => errors.push(error) },
    )
    await nextImmediate()
    loop.stop()
    expect(errors).toHaveLength(1)
  })
})
