import { createTestRoot, type TestRoot } from "@ghia/react/testing"
import { Counter } from "./counter.tsx"

console.log("ENTRY_RUN entry v1")

// A full reload does not tear the old run down, and the test renderer holds the old run's callbacks.
const slot = globalThis as typeof globalThis & { previousRoot?: TestRoot }
slot.previousRoot?.unmount()
const app = createTestRoot()
slot.previousRoot = app
app.render(<Counter />)
// The state to keep: a click, so the count cannot come from the first render.
app.renderer.nativeSimulateClick(10, 10)
const text = () => app.renderer.getAllText().join("")
console.log(`RENDERED ${text()}`)

if (import.meta.hot) {
  // Reports the tree after a hot update; the interval also keeps `ghia dev` alive.
  let last = text()
  setInterval(() => {
    app.renderer.flush()
    if (text() === last) return
    last = text()
    console.log(`UPDATED ${last}`)
  }, 50)
} else {
  app.unmount()
}
