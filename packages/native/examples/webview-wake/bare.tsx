import React from "react"
import { render } from "@ghia/react"
import { GpuixRenderer } from "@ghia/native"
const wakes: number[] = []
const set = GpuixRenderer.prototype.setFrameWakeCallback
GpuixRenderer.prototype.setFrameWakeCallback = function (cb) { return set.call(this, cb ? () => { wakes.push(performance.now()); cb() } : cb) }
render(<div style={{ width: 300, height: 200, backgroundColor: "#eee" }}><text>bare</text></div>, { title: "bare", width: 300, height: 200 })
await new Promise((r) => setTimeout(r, 8000))
const from = performance.now(); const n0 = wakes.length
await new Promise((r) => setTimeout(r, 15000))
console.log(`bare window rest: ${wakes.length - n0} wakes in 15 s at`, wakes.slice(n0).map((w) => Math.round(w - from)).join(","))
process.exit(0)
