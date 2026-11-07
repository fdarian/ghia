import "./record-window.ts"
import { isServer } from "solid-js/web"
import { TestRenderer } from "@ghia/native/testing"

const renderer = new TestRenderer()
renderer.applyBatch(JSON.stringify([["createElement", 1, "text"], ["setText", 1, "marker v1"], ["setRoot", 1]]))
renderer.flush()
console.log(`IS_SERVER ${isServer}`)
console.log(`RENDERED ${renderer.getAllText().join("")}`)
renderer.dispose()
