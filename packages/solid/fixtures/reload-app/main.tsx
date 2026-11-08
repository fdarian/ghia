import * as solid from "solid-js"
import * as ghiaSolid from "@ghia/solid"
import { createTestRoot, type TestRoot } from "@ghia/solid/testing"
import { Label } from "./label.tsx"

console.log("ENTRY_RUN entry v1")

interface Slot {
  previous?: TestRoot
  modules?: WeakRef<object>[]
}
const slot = globalThis as typeof globalThis & { reloadAppSlot?: Slot }
slot.reloadAppSlot ??= {}
const state = slot.reloadAppSlot

// A full reload does not tear the old run down, and the test renderer holds the old run's callbacks.
state.previous?.unmount()
const app = createTestRoot()
state.previous = app
const [count, setCount] = solid.createSignal(1)
app.render(() => <Label count={count()} />)
app.flushSync(() => setCount(2))
const text = () => app.renderer.getAllText().join("")
console.log(`RENDERED ${text()}`)

// The listener belongs to this run: it goes away with the run's HMR client data.
import.meta.hot!.on("vite:afterUpdate", () => {
  setTimeout(() => console.log(`UPDATED ${text()}`), 50)
})

// WeakRefs to this run's solid-js and @ghia/solid, checked once the run has settled.
state.modules ??= []
state.modules.push(new WeakRef(solid), new WeakRef(ghiaSolid))
const modules = state.modules
setTimeout(() => {
  Bun.gc(true)
  console.log(`MODULES_ALIVE ${JSON.stringify(modules.map((module) => module.deref() !== undefined))}`)
}, 300)
