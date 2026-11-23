// Spawned by test-renderer-close.test.ts: disposes a renderer without running the main run loop,
// so its window's close block is still queued when its app is released, then creates and disposes
// another renderer, whose run loop pass runs that block.
import { TestRenderer } from "../../testing.js"

type NativeSide = { disposeLeavingMainQueueForTest(): void }

const first = new TestRenderer({ width: 200, height: 200 })
;(first as unknown as { native: NativeSide }).native.disposeLeavingMainQueueForTest()

const second = new TestRenderer({ width: 200, height: 200 })
second.dispose()
console.log("survived")
