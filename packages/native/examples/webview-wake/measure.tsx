/** How often a window with a `<webview>` wakes JS at rest, and how long each event of the page
 *  takes to arrive in an idle app. Prints one line per measurement.
 *
 *  bun measure.tsx            the addon this checkout built
 *  NAPI_RS_NATIVE_LIBRARY_PATH=<other>.node bun measure.tsx
 */
import React from "react"
import { render } from "@ghia/react"
import type { WebviewInstance } from "@ghia/react"
import { GpuixRenderer } from "@ghia/native"

const FIXTURE = new URL("./fixture.html", import.meta.url).pathname
const REST_MS = Number(process.env.REST_MS ?? 10000)
const TRIALS = Number(process.env.TRIALS ?? 8)
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 2000)

const wakes: number[] = []
const setFrameWakeCallback = GpuixRenderer.prototype.setFrameWakeCallback
GpuixRenderer.prototype.setFrameWakeCallback = function (callback) {
  return setFrameWakeCallback.call(this, callback ? () => { wakes.push(performance.now()); callback() } : callback)
}

type EventName = "did-start-loading" | "did-navigate" | "page-title-updated" | "did-stop-loading" | "did-fail-load"
const arrivals = new Map<EventName, number[]>()
const waiters: Array<() => void> = []
const record = (name: EventName) => () => {
  const list = arrivals.get(name) ?? []
  list.push(performance.now())
  arrivals.set(name, list)
  for (const waiter of waiters.splice(0)) waiter()
}

const titles: Array<{ arrivedAt: number; title: string }> = []
const recordTitle = (event: { title?: string }) => {
  titles.push({ arrivedAt: Date.now(), title: event.title ?? "" })
  record("page-title-updated")()
}

let view: WebviewInstance | null = null

function App() {
  return (
    <div style={{ width: 640, height: 480, backgroundColor: "#eeeeee" }}>
      <webview
        ref={(instance: WebviewInstance | null) => { view = instance }}
        src={`file://${FIXTURE}`}
        style={{ position: "absolute", left: 20, top: 20, width: 600, height: 440 }}
        onDidStartLoading={record("did-start-loading")}
        onDidNavigate={record("did-navigate")}
        onPageTitleUpdated={recordTitle}
        onDidStopLoading={record("did-stop-loading")}
        onDidFailLoad={record("did-fail-load")}
      />
    </div>
  )
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function seen(name: EventName, since: number) {
  return (arrivals.get(name) ?? []).find((at) => at >= since)
}

async function until(what: string, condition: () => boolean, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), sleep(50)])
  }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const max = (values: number[]) => Math.max(...values)
const fixed = (value: number) => value.toFixed(1)

function summary(name: string, values: number[]) {
  console.log(`latency ${name.padEnd(20)} median ${fixed(median(values)).padStart(7)} ms  max ${fixed(max(values)).padStart(7)} ms  (n=${values.length})`)
}

async function main() {
  const startedAt = performance.now()
  render(<App />, { title: "gpuix webview wake", width: 640, height: 480 })
  await until("the first load", () => view !== null && seen("did-stop-loading", 0) !== undefined)
  console.log(`first load done ${Math.round(performance.now() - startedAt)} ms after render; wakes so far at ${wakes.map((at) => Math.round(at - startedAt)).join(",")}`)
  await sleep(SETTLE_MS)

  const restFrom = performance.now()
  console.log(`rest began at epoch ms ${Date.now() % 100000}`)
  const before = wakes.length
  await sleep(REST_MS)
  const count = wakes.filter((at) => at >= restFrom).length
  const offsets = wakes.filter((at) => at >= restFrom).map((at) => Math.round(at - restFrom))
  console.log(`rest wakes at ms after the rest began: ${offsets.join(",")}`)
  console.log(`rest: ${count} wakes in ${(REST_MS / 1000).toFixed(0)} s (${(count / (REST_MS / 1000)).toFixed(2)}/s) with a loaded webview; ${before} wakes before it`)

  const timings: Record<string, number[]> = {}
  const add = (name: string, value: number) => (timings[name] ??= []).push(value)
  for (let trial = 0; trial < TRIALS; trial++) {
    await sleep(SETTLE_MS)
    const started = performance.now()
    view!.reload()
    await until("reload", () => seen("did-stop-loading", started) !== undefined)
    for (const name of ["did-start-loading", "did-navigate", "page-title-updated", "did-stop-loading"] as const) {
      const at = seen(name, started)
      if (at !== undefined) add(`reload ${name}`, at - started)
    }

    await sleep(SETTLE_MS)
    const failing = performance.now()
    view!.loadURL("file:///nonexistent-wake-test.html")
    await until("a failed load", () => seen("did-fail-load", failing) !== undefined)
    add("loadURL did-fail-load", seen("did-fail-load", failing)! - failing)
    await until("the failed load to stop", () => seen("did-stop-loading", failing) !== undefined)
    view!.loadURL(`file://${FIXTURE}`)
    await until("the fixture again", () => seen("did-stop-loading", failing + 1) !== undefined && (arrivals.get("did-stop-loading")?.length ?? 0) >= 3)

    await sleep(SETTLE_MS)
    const asked = performance.now()
    const result = await view!.executeJavaScript("1 + 1")
    if (result !== 2) throw new Error(`executeJavaScript returned ${result}`)
    add("executeJavaScript", performance.now() - asked)

    await sleep(SETTLE_MS)
    // The page changes its own title 300 ms from now, without being asked anything else: how long
    // after it did so does the event reach JS?
    const titled = performance.now()
    await view!.executeJavaScript("setTimeout(() => { document.title = String(Date.now()) }, 300); 0")
    await until("the page's own title change", () => seen("page-title-updated", titled + 200) !== undefined, 5000)
    const own = titles.filter((entry) => /^\d+$/.test(entry.title)).pop()
    if (own === undefined) throw new Error("the page's own title never arrived")
    add("page-initiated title", own.arrivedAt - Number(own.title))
  }
  for (const name of Object.keys(timings)) summary(name, timings[name])
  console.log(`wakes in total ${wakes.length}`)
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
