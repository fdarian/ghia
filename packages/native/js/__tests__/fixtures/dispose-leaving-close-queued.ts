// Spawned by test-renderer-close.test.ts: disposes a renderer without running the main run loop,
// so its window's close block is still queued when its app is released, then creates another
// renderer and runs the main queue up to a marker block while that renderer's app is alive. The
// queue is FIFO, so the first renderer's block has run by the time the marker has.
import { runMainQueueToMarkerForTest } from "../../../index.js"
import { TestRenderer } from "../../testing.js"

type NativeSide = { disposeLeavingMainQueueForTest(): void }

const first = new TestRenderer({ width: 200, height: 200 })
;(first as unknown as { native: NativeSide }).native.disposeLeavingMainQueueForTest()

const second = new TestRenderer({ width: 200, height: 200 })
runMainQueueToMarkerForTest()
second.dispose()
console.log("survived")
