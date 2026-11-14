import { createTestRoot } from "@ghia/solid/testing"
import { document } from "@ghia/native/host"
import { Overlay, Tag, rendersOnGhia } from "solid-headless-lib"
import notes from "./notes.json"

console.log(`RENDERS_ON_GHIA ${rendersOnGhia}`)
// Its text names solid-js/web: a JSON module is not scanned for imports of it.
console.log(`NOTES ${Object.keys(notes)}`)

const app = createTestRoot()
function Custom(props: { children?: unknown }) {
  return <article>{props.children as string}</article>
}
app.render(() => (
  <main>
    <Tag as="section">tag</Tag>
    <Tag as={Custom}>component</Tag>
    <Overlay>overlay</Overlay>
  </main>
))
const body = () => [...document.body.children].map((child) => child.tagName.toLowerCase())
console.log(`BODY ${body().join(",")}`)
console.log(`TEXT ${app.renderer.getAllText().filter(Boolean).join("|")}`)
app.unmount()
console.log(`BODY_AFTER ${body().join(",")}`)
