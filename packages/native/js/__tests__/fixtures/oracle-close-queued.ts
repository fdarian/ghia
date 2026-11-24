// Spawned by test-renderer-close.test.ts: disposes a RowOracle, or replaces it with another, then
// runs the main queue up to a marker block while a later oracle's app is alive. The queue is FIFO,
// so a close block that the first oracle's window left queued has run by the time the marker has.
import { RowOracle, runMainQueueToMarkerForTest } from "../../../index.js"

const options = { width: 200, height: 200 }
const mode = process.argv[2]

const first = new RowOracle(options)
if (mode === "dispose") {
  first.dispose()
} else if (mode !== "replace") {
  throw new Error(`mode must be dispose or replace, got ${mode}`)
}

const second = new RowOracle(options)
runMainQueueToMarkerForTest()
second.dispose()
console.log("survived")
