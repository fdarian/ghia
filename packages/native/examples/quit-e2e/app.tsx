/** The app of one quit case: a minimal window on the real frame loop (the run-loop wake path, no
 *  `frameMs`), idle for `IDLE_MS`, then one quit request. Its folder and case come from the environment. */
import { renameSync, writeFileSync } from "node:fs"
import { dlopen, FFIType } from "bun:ffi"
import React from "react"
import { render } from "@ghia/react"
import type { GpuixRenderer } from "@ghia/native"
import { ownRenderer } from "@ghia/native/host"
import { CASES, HELPER_PATH, IDLE_MS, READY_FILE, REQUEST_FILE, TERMINATED_FILE, type CaseName } from "./paths"

const folder = process.env.QUIT_E2E_DIR
const name = process.env.QUIT_E2E_CASE as CaseName | undefined
if (!folder || !name || !CASES.includes(name)) throw new Error("QUIT_E2E_DIR and QUIT_E2E_CASE (one of " + CASES.join(", ") + ") are required")

// Written aside and renamed into place: the runner polls these files and must never parse half of one.
const leave = (file: string, body: object) => {
  const temporary = `${folder}/${file}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...body, time: Date.now() }))
  renameSync(temporary, `${folder}/${file}`)
}

// The adapter's onTerminated runs process.exit(0): the marker is written by what it calls.
const exit = process.exit.bind(process)
process.exit = ((code?: number) => {
  leave(TERMINATED_FILE, { code: code ?? 0 })
  exit(code)
}) as typeof process.exit

const helper = dlopen(HELPER_PATH, {
  qe_visible_windows: { args: [], returns: FFIType.i32 },
  qe_close_window_later: { args: [], returns: FFIType.i32 },
})

if (name === "apple-event-server") Bun.serve({ port: 0, fetch: () => new Response("ok") })

render(
  <div style={{ width: 300, height: 200, backgroundColor: "#eeeeee" }}>
    <div>quit e2e</div>
  </div>,
  { title: "gpuix quit e2e", width: 300, height: 200, focus: false }
)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// A machine that gives the app no window (screen locked or asleep) reports it and waits to be killed.
const windowDeadline = Date.now() + 10000
while (helper.symbols.qe_visible_windows() === 0 && Date.now() < windowDeadline) await sleep(50)
if (helper.symbols.qe_visible_windows() === 0) {
  leave(READY_FILE, { pid: process.pid, windows: 0 })
  await sleep(60000)
}
await sleep(IDLE_MS)
leave(READY_FILE, { pid: process.pid, windows: helper.symbols.qe_visible_windows() })

if (name === "quit-action") {
  const renderer = ownRenderer() as GpuixRenderer | undefined
  if (!renderer) throw new Error("render() has opened no window of its own")
  leave(REQUEST_FILE, {})
  renderer.simulateKeystrokes("Meta+q")
} else if (name === "last-window-close") {
  leave(REQUEST_FILE, {})
  if (helper.symbols.qe_close_window_later() !== 1) throw new Error("the app has no visible window to close")
}
