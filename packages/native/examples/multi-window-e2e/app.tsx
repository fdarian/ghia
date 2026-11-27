/** The app of one case: two renderers, so two real windows on one GPUI App, each with a React root of its
 *  own, on the real frame loop (the run-loop wake path). It looks at the windows through the automation
 *  tree and AppKit's window count, closes one, looks again, and then ends the app as the case says. Its
 *  folder and case come from the environment. */
import { renameSync, writeFileSync } from "node:fs"
import { dlopen, FFIType } from "bun:ffi"
import React from "react"
import { createRoot } from "@ghia/react"
import { createNativeRenderer, startFrameLoop } from "@ghia/native/runtime"
import type { GpuixRenderer } from "@ghia/native"
import { CASES, HELPER_PATH, READY_FILE, REPORT_FILE, TERMINATED_FILE, type CaseName, type Report } from "./paths"

const folder = process.env.MULTI_WINDOW_E2E_DIR
const name = process.env.MULTI_WINDOW_E2E_CASE as CaseName | undefined
if (!folder || !name || !CASES.includes(name)) {
  throw new Error("MULTI_WINDOW_E2E_DIR and MULTI_WINDOW_E2E_CASE (one of " + CASES.join(", ") + ") are required")
}

// Written aside and renamed into place: the runner polls these files and must never parse half of one.
const leave = (file: string, body: object) => {
  const temporary = `${folder}/${file}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...body, time: Date.now() }))
  renameSync(temporary, `${folder}/${file}`)
}

const helper = dlopen(HELPER_PATH, {
  qe_visible_windows: { args: [], returns: FFIType.i32 },
  qe_close_window_later: { args: [], returns: FFIType.i32 },
})
const visibleWindows = () => helper.symbols.qe_visible_windows()
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return true
    await sleep(20)
  }
  return condition()
}

interface TreeNode {
  testId?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: TreeNode[]
}
function find(node: TreeNode, testId: string): TreeNode | undefined {
  if (node.testId === testId) return node
  for (const child of node.children ?? []) {
    const found = find(child, testId)
    if (found) return found
  }
  return undefined
}
const treeOf = (renderer: GpuixRenderer): TreeNode => JSON.parse(renderer.getAutomationTree())

// What the app does when it is told it ended: counted, and the process leaves a moment later, so a second
// call (the loop was to run it once) is still counted.
let terminatedCalls = 0
const onTerminated = () => {
  terminatedCalls += 1
  leave(TERMINATED_FILE, { calls: terminatedCalls })
  setTimeout(() => process.exit(0), 250)
}
const windowClosedCalls = { alpha: 0, beta: 0 }
const onError = (error: unknown) => console.error("[multi-window-e2e] frame error", error)

const alpha = createNativeRenderer({ onError })
const beta = createNativeRenderer({ onError })
alpha.init({ title: "multi-window e2e alpha", width: 300, height: 200, x: 80, y: 120, focus: false })
beta.init({ title: "multi-window e2e beta", width: 420, height: 280, x: 460, y: 120, focus: false })
startFrameLoop(alpha, { onTerminated, onError, onWindowClosed: () => (windowClosedCalls.alpha += 1) })
startFrameLoop(beta, { onTerminated, onError, onWindowClosed: () => (windowClosedCalls.beta += 1) })

const setters: Record<string, (text: string) => void> = {}
function Page({ id, width, height }: { id: string; width: number; height: number }) {
  const [text, setText] = React.useState(`${id} window`)
  setters[id] = setText
  return (
    <div testId={id} style={{ width, height, backgroundColor: id === "alpha" ? "#cfe3ff" : "#ffe3cf" }}>
      <div>{text}</div>
    </div>
  )
}
createRoot(alpha).render(<Page id="alpha" width={250} height={120} />)
createRoot(beta).render(<Page id="beta" width={350} height={180} />)

// A machine that gives the app no windows (screen locked or asleep) reports it and waits to be killed.
if (!(await until(() => visibleWindows() >= 2, 10000))) {
  leave(READY_FILE, { pid: process.pid, windows: visibleWindows() })
  await sleep(60000)
}
await sleep(500)
leave(READY_FILE, { pid: process.pid, windows: visibleWindows() })

const alphaNode = find(treeOf(alpha), "alpha")
const betaNode = find(treeOf(beta), "beta")
const windowsAtStart = visibleWindows()
const alphaHasOwnTree = alphaNode?.bounds?.width === 250 && find(treeOf(alpha), "beta") === undefined
const betaHasOwnTree = betaNode?.bounds?.width === 350 && find(treeOf(beta), "alpha") === undefined
const boundsDiffer = alphaNode?.bounds?.height !== betaNode?.bounds?.height
// "close-button" has AppKit close a window the way the close button does, and sees which one it was.
if (name === "close-button") {
  if (helper.symbols.qe_close_window_later() !== 1) throw new Error("the app has no visible window to close")
  await until(() => alpha.isWindowClosed() || beta.isWindowClosed(), 3000)
}
const closedId: "alpha" | "beta" = name === "close-first" || (name === "close-button" && alpha.isWindowClosed()) ? "alpha" : "beta"
const closing = closedId === "alpha" ? alpha : beta
const survivor = closedId === "alpha" ? beta : alpha
const survivorId = closedId === "alpha" ? "beta" : "alpha"
const report: Report = {
  windowsAtStart,
  alphaHasOwnTree,
  betaHasOwnTree,
  boundsDiffer,
  closed: name === "quit" ? null : closedId,
  windowsAfterClose: -1,
  closedRendererSawIt: false,
  survivorStillOpen: false,
  survivorRedrew: false,
  survivorWasShown: false,
  survivorShowsUpdate: false,
  windowClosedCalls,
}

if (name !== "quit") {
  if (name !== "close-button") closing.closeWindow()
  report.closedRendererSawIt = await until(() => closing.isWindowClosed() && windowClosedCalls[closedId] === 1, 3000)
  report.windowsAfterClose = visibleWindows()
  report.survivorStillOpen = !survivor.isWindowClosed()
  // A change after the close: the surviving window must still be pumped and drawn. A window the system
  // does not show (occluded, the screen off) gets no frames from its display link, so only a visible one
  // is asked for a frame; what it paints is asked for in either case, which draws what is pending.
  const framesBefore = survivor.getPaintedFrameCount()
  setters[survivorId]?.(`${survivorId} window updated`)
  report.survivorWasShown = survivor.isWindowVisible()
  report.survivorRedrew = report.survivorWasShown ? await until(() => survivor.getPaintedFrameCount() > framesBefore, 3000) : true
  report.survivorShowsUpdate = await until(() => JSON.stringify(survivor.getPaintedText()).includes("updated"), 3000)
}
leave(REPORT_FILE, report)

// Ending the app: the last window closing, or a quit asked of the platform.
await sleep(100)
if (name === "close-all") {
  survivor.closeWindow()
} else {
  survivor.simulateKeystrokes("Meta+q")
}
// Nothing else to do: the frame loop ends the process through `onTerminated`.
await sleep(60000)
