import { createTestRoot } from "@ghia/solid/testing"
import { document } from "@ghia/native/host"
import { Overlay, Tag, rendersOnGhia } from "solid-headless-lib"

console.log(`RENDERS_ON_GHIA ${rendersOnGhia}`)

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
