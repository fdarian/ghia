import { render } from "@ghia/solid"
import { TestRenderer } from "@ghia/native/testing"

console.log("ENTRY_RUN document v1")

// What the entry writes to `document` before `render()`: a browser keeps it across a reload.
let pings = 0
document.documentElement.classList.add("dark")
document.body.addEventListener("ping", () => {
  pings++
})

// The window outlives a full reload, as the live one does.
const slot = globalThis as typeof globalThis & { documentAppRenderer?: TestRenderer }
slot.documentAppRenderer ??= new TestRenderer()
render(() => <div>document app</div>, { renderer: slot.documentAppRenderer })

document.body.dispatchEvent(new Event("ping"))
const root = document.documentElement
console.log(`DOCUMENT class=${root.className} pings=${pings} connected=${root.isConnected}`)

setInterval(() => {}, 1000)
