/** One reload with every wake and event time-stamped, to see what a missing event is waiting for. */
import React from "react"
import { render } from "@ghia/react"
import type { WebviewInstance } from "@ghia/react"
import { GpuixRenderer } from "@ghia/native"
import { dlopen, FFIType, read, ptr } from "bun:ffi"
const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", { CFRunLoopGetMain: { args: [], returns: FFIType.ptr } })
const sys = dlopen("/usr/lib/libSystem.B.dylib", {
  mach_task_self: { args: [], returns: FFIType.u32 },
  mach_port_get_attributes: { args: [FFIType.u32, FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
})
const rl = cf.symbols.CFRunLoopGetMain()!
const status = new Uint32Array(10)
const count = new Uint32Array([10])
const msgs = () => {
  count[0] = 10
  const kr = 0
  return kr
}
const state = () => {
  count[0] = 10
  sys.symbols.mach_port_get_attributes(sys.symbols.mach_task_self(), read.u32(rl, 0x50), 2, ptr(status), ptr(count))
  return `f0=${read.u8(rl, 0x153)} f1=${read.u8(rl, 0x154)} q=${status[4]}`
}
const FIXTURE = new URL("./fixture.html", import.meta.url).pathname
const t0 = performance.now()
const at = () => Math.round(performance.now() - t0)
const log: string[] = []
const set = GpuixRenderer.prototype.setFrameWakeCallback
let forceWake: (() => void) | null = null
GpuixRenderer.prototype.setFrameWakeCallback = function (cb) { forceWake = cb ?? null; return set.call(this, cb ? () => { log.push(`wake@${at()}[${state()}]`); cb() } : cb) }
const ev = (n: string) => () => log.push(`${n}@${at()}`)
let view: WebviewInstance | null = null
function App() {
  return <div style={{ width: 640, height: 480 }}><webview ref={(i: WebviewInstance | null) => { view = i }} src={`file://${FIXTURE}`} style={{ position: "absolute", left: 20, top: 20, width: 600, height: 440 }}
    onDidStartLoading={ev("START")} onDidNavigate={ev("NAV")} onDidStopLoading={ev("STOP")} onPageTitleUpdated={ev("TITLE")} /></div>
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
render(<App />, { title: "trace", width: 640, height: 480 })
await sleep(Number(process.env.PRE ?? 4000))
log.push(`--- reload called@${at()}`)
view!.reload()
const reloadedAt = performance.now()
const forceAfter = Number(process.env.FORCE_AFTER ?? 0)
let forced = false
const poll = setInterval(() => {
  log.push(`poll@${at()}[${state()}]`)
  if (forceAfter > 0 && !forced && performance.now() - reloadedAt > forceAfter) { forced = true; log.push(`FORCE@${at()}`); forceWake!() }
}, 100)
await sleep(Number(process.env.POST ?? 4000))
clearInterval(poll)
console.log(log.slice(-Number(process.env.TAIL ?? 40)).join(" "))
process.exit(0)
