import { createSignal } from "solid-js"
import { isServer } from "solid-js/web"
import { createTestRoot } from "@ghia/solid/testing"
import { Label } from "./label.tsx"

console.log("ENTRY_RUN")
console.log(`IS_SERVER ${isServer}`)

const [count, setCount] = createSignal(1)
const app = createTestRoot()
app.render(() => <Label count={count()} />)
app.flushSync(() => setCount(2))
const text = () => app.renderer.getAllText().join("")
console.log(`RENDERED ${text()}`)

if (import.meta.hot) {
  // Reports the tree after a hot update; the interval also keeps `ghia dev` alive.
  let last = text()
  setInterval(() => {
    if (text() === last) return
    last = text()
    console.log(`UPDATED ${last}`)
  }, 50)
} else {
  app.unmount()
}
