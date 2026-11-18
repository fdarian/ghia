/**
 * Each key event native hands to JS gets its own microtask checkpoint, as a browser runs one
 * after each task. The keys go through AppKit's queue and the pump a live window's `tick()`
 * runs (`pumpNativeEvents`): the pump ends after the first key event it sends, and the loop
 * turns before the next call.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { EventPayload } from "../../index.js"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer && process.platform === "darwin" ? describe : describe.skip

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describeNative("a key event and the microtask checkpoint", () => {
  const log: string[] = []
  let renderer: TestRenderer

  // One renderer for the file: a pump of a second one runs main-queue work the first left behind.
  beforeAll(() => {
    renderer = new TestRenderer({
      width: 200,
      height: 200,
      dispatchSyncEvent: (event: EventPayload) => {
        if (event.eventType === "keydown") {
          log.push(`keydown ${event.key}`)
          queueMicrotask(() => log.push(`microtask ${event.key}`))
        }
        return { defaultPrevented: false, propagationStopped: false }
      },
    })
    renderer.clockPause()
    renderer.applyBatch(
      encodeWireBatchForTest([
        ["createElement", 1, "div"],
        ["setRoot", 1],
        ["setStyle", 1, { width: 100, height: 100 }],
      ])
    )
    renderer.flush()
    renderer.setWindowKeyEvents(true, false, 1)
  })

  afterAll(() => {
    renderer.setYieldAfterKeyEvent(true)
    renderer.dispose()
  })

  /** What the page saw of `keys`, all posted before the first pump: each keydown and the microtask it queued. */
  async function typeInOneTick(keys: string, yieldAfterKey: boolean): Promise<string[]> {
    log.length = 0
    renderer.setYieldAfterKeyEvent(yieldAfterKey)
    renderer.postNativeKeys(keys)
    // One pump per key event, the keyUps included, so that nothing stays queued for the next test.
    for (let pump = 0; pump < 2 * keys.length + 1; pump++) {
      renderer.pumpNativeEvents()
      await nextTask()
    }
    return [...log]
  }

  it("runs the microtasks one key queued before the next key's keydown", async () => {
    expect(await typeInOneTick("abc", true)).toEqual([
      "keydown a",
      "microtask a",
      "keydown b",
      "microtask b",
      "keydown c",
      "microtask c",
    ])
  })

  it("shares one checkpoint between the keys of one pump when the pump does not end after a key", async () => {
    expect(await typeInOneTick("abc", false)).toEqual([
      "keydown a",
      "keydown b",
      "keydown c",
      "microtask a",
      "microtask b",
      "microtask c",
    ])
  })

  it("reports a key left queued or just sent, so the frame loop ticks again at once", async () => {
    renderer.setYieldAfterKeyEvent(true)
    renderer.postNativeKeys("a")
    renderer.pumpNativeEvents()
    expect(renderer.keyEventPending()).toBe(true)
    renderer.pumpNativeEvents()
    expect(renderer.keyEventPending()).toBe(true)
    await nextTask()
    renderer.pumpNativeEvents()
    expect(renderer.keyEventPending()).toBe(false)
  })
})
