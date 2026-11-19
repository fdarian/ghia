import { describe, expect, it } from "vitest"
import {
  connectTest,
  liveRendererAsTest,
  type LiveAutomationRenderer,
} from "../automation/client.js"

interface MoveCall {
  x: number
  y: number
  pressedButton: number | undefined
}

/**
 * A live renderer as the addon behaves: a press or release reaches the page inside the
 * call, a move only on a later turn of the event loop.
 */
function fakeLiveRenderer() {
  const moves: MoveCall[] = []
  const heard: string[] = []
  const queuedMove = (x: number) => {
    setTimeout(() => heard.push(`move:${x}`), 0)
  }
  const renderer: LiveAutomationRenderer = {
    simulateClick() {
      heard.push("click")
    },
    simulateMouseDown(x) {
      heard.push(`down:${x}`)
    },
    simulateMouseUp(x) {
      heard.push(`up:${x}`)
    },
    simulateMouseMove(x, y, pressedButton) {
      moves.push({ x, y, pressedButton })
      queuedMove(x)
    },
    simulateScrollWheel() {},
    focusElement() {},
    blur() {},
    scrollTo() {},
    getScrollOffset: () => null,
    getAllText: () => [],
    getPaintedText: () => [],
    getSelectedText: () => null,
    clearSelection() {},
    getAutomationTree: () =>
      JSON.stringify({
        id: 1,
        type: "div",
        testId: "handle",
        bounds: { x: 90, y: 0, width: 20, height: 100 },
        children: [],
      }),
    getElementBounds: () => ({ x: 90, y: 0, width: 20, height: 100 }),
    clockPause: () => 0,
    clockSet: () => 0,
    clockFastForward: () => 0,
    clockResume: () => 0,
  }
  return { renderer, moves, heard }
}

describe("liveRendererAsTest", () => {
  it("dragBy reaches the page as a press, the moves, then the release", async () => {
    const live = fakeLiveRenderer()
    const app = await connectTest(liveRendererAsTest(live.renderer))

    await app.getByTestId("handle").dragBy(40, 0, { steps: 4 })

    expect(live.heard).toEqual([
      "move:100",
      "down:100",
      "move:110",
      "move:120",
      "move:130",
      "move:140",
      "up:140",
    ])
  })

  it("every move after a press names the held button, none before or after", async () => {
    const live = fakeLiveRenderer()
    const app = await connectTest(liveRendererAsTest(live.renderer))

    await app.getByTestId("handle").dragBy(20, 0, { steps: 2 })
    await app.mouse.move({ x: 5, y: 5 })

    expect(live.moves.map((move) => move.pressedButton)).toEqual([
      undefined,
      0,
      0,
      undefined,
    ])
  })

  it("a drag with another button names that button on its moves", async () => {
    const live = fakeLiveRenderer()
    const app = await connectTest(liveRendererAsTest(live.renderer))

    await app.mouse.drag({ x: 0, y: 0 }, { x: 10, y: 0 }, { button: 2, steps: 1 })

    expect(live.moves.map((move) => move.pressedButton)).toEqual([undefined, 2])
  })

  it("a sequence of keys is pressed one at a time, with a microtask and a loop turn between two", async () => {
    const live = fakeLiveRenderer()
    const keys: string[] = []
    live.renderer.simulateKeystrokes = (press) => {
      keys.push(press)
      // An editor that commits its update in a microtask (Lexical) has done so before the next key.
      queueMicrotask(() => live.heard.push(`committed:${press}`))
    }
    const test = liveRendererAsTest(live.renderer)

    await test.simulateKeystrokes("m  i\td")

    expect(keys).toEqual(["m", "i", "d"])
    expect(live.heard).toEqual(["committed:m", "committed:i", "committed:d"])
  })

  it("an input draws the frame a started link owes after the tick and the microtasks, before the loop turn", async () => {
    const live = fakeLiveRenderer()
    let pending = true
    live.renderer.tick = () => live.heard.push("tick")
    live.renderer.simulateKeystrokes = () => {
      queueMicrotask(() => live.heard.push("microtask"))
    }
    live.renderer.startedLinksPending = () => pending
    live.renderer.stepStartedLinks = () => {
      live.heard.push("frame")
      pending = false
      return true
    }
    setTimeout(() => live.heard.push("timer"), 0)

    await liveRendererAsTest(live.renderer).simulateKeystrokes("a")

    expect(live.heard).toEqual(["tick", "microtask", "frame", "timer"])
  })

  it("an input with no link waiting makes no frame call", async () => {
    const live = fakeLiveRenderer()
    let calls = 0
    live.renderer.tick = () => {}
    live.renderer.startedLinksPending = () => false
    live.renderer.stepStartedLinks = () => {
      calls += 1
      return false
    }

    await liveRendererAsTest(live.renderer).nativeSimulateClick(1, 1)

    expect(calls).toBe(0)
  })

  it("an empty sequence is left to native to refuse", async () => {
    const live = fakeLiveRenderer()
    live.renderer.simulateKeystrokes = (press) => {
      if (press.trim() === "") throw new Error("No keys to press")
    }

    await expect(liveRendererAsTest(live.renderer).simulateKeystrokes(" ")).rejects.toThrow("No keys to press")
  })
})
