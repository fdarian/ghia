import { render } from "@ghia/react"
import { App } from "./diff"

render(<App />, {
  title: "GPUIX Diff Viewer",
  width: 900,
  height: 600,
  // Agent checks need real GPU paint, not control of the user's keyboard.
  focus: process.env.GPUIX_BACKGROUND !== "1",
})
