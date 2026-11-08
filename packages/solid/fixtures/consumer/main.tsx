import { isServer } from "solid-js/web"
import { createTestRoot } from "@ghia/solid/testing"
import { createView } from "./view.tsx"

const app = createTestRoot()
const fixture = createView()
app.render(fixture.view)
app.flushSync(fixture.update)
console.log(`IS_SERVER ${isServer}`)
console.log(`RENDERED ${app.renderer.getAllText().join("")}`)
app.unmount()
