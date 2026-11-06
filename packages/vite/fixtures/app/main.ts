import "./record-window.ts"
import { isServer } from "solid-js/web"
import { createComponent, createElement, insert } from "@ghia/solid"
import { createTestRoot } from "@ghia/solid/testing"

function Marker() {
  const text = createElement("text")
  insert(text, "marker v1")
  return text
}

const app = createTestRoot()
app.render(() => createComponent(Marker, {}))
console.log(`IS_SERVER ${isServer}`)
console.log(`RENDERED ${app.renderer.getAllText().join("")}`)
app.unmount()
