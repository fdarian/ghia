/** Runs each case against a fresh app process and prints a table. Exit status: 0 every case passed,
 *  1 a case failed, 2 the e2e could not run, 3 the machine gave the app no windows. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { CASES, OUT, READY_FILE, REPORT_FILE, TERMINATED_FILE, type CaseName, type Report } from "./paths"

const EXIT_PASSED = 0
const EXIT_FAILED = 1
const EXIT_COULD_NOT_RUN = 2
const EXIT_NOT_CHECKABLE = 3

/** How long the app has, from its report, to end by itself (the last window closed or a quit). */
const END_LIMIT_MS = 3000

class NotCheckable extends Error {}

let current: { app: ReturnType<typeof Bun.spawn>; folder: string } | null = null

for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    if (current) {
      current.app.kill("SIGKILL")
      rmSync(current.folder, { recursive: true, force: true })
    }
    process.exit(status)
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function read<T extends object>(folder: string, file: string): (T & { time: number }) | null {
  const path = `${folder}/${file}`
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null
}

async function waitForFile<T extends object>(folder: string, file: string, exited: Promise<number>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let appExited = false
  void exited.then(() => (appExited = true))
  while (Date.now() < deadline) {
    const found = read<T>(folder, file)
    if (found) return found
    if (appExited) throw new Error(`the app ended before it wrote ${file}`)
    await sleep(20)
  }
  throw new Error(`the app did not write ${file} within ${timeoutMs} ms`)
}

interface Result {
  name: CaseName
  problems: string[]
}

async function runCase(name: CaseName): Promise<Result> {
  const folder = mkdtempSync(`${tmpdir()}/gpuix-multi-window-e2e-${name}-`)
  const app = Bun.spawn(["bun", "app.tsx"], {
    env: { ...process.env, MULTI_WINDOW_E2E_CASE: name, MULTI_WINDOW_E2E_DIR: folder },
    stdout: "inherit",
    stderr: "inherit",
  })
  current = { app, folder }
  try {
    const ended = app.exited.then((code) => ({ code, at: Date.now() }))
    const ready = await waitForFile<{ windows: number }>(folder, READY_FILE, app.exited, 30000)
    if (ready.windows < 2) throw new NotCheckable("the app's windows never became visible (screen locked or asleep, or no window server session)")
    const report = await waitForFile<Report>(folder, REPORT_FILE, app.exited, 30000)
    const result = await Promise.race([ended, sleep(END_LIMIT_MS).then(() => null)])
    const terminated = read<{ calls: number }>(folder, TERMINATED_FILE)
    const problems: string[] = []
    if (report.windowsAtStart !== 2) problems.push(`${report.windowsAtStart} windows at the start, not 2`)
    if (report.crossWindowCall !== "ok") problems.push(`a handler of one window calling the other renderer: ${report.crossWindowCall}`)
    if (!report.alphaHasOwnTree) problems.push("the first window does not hold its own tree")
    if (!report.betaHasOwnTree) problems.push("the second window does not hold its own tree")
    if (!report.boundsDiffer) problems.push("the two windows report the same bounds")
    if (name === "window-open") {
      const opened = report.windowOpen
      if (opened === null) problems.push("the app did not report what window.open did")
      else {
        if (opened.windowsWhileOpen !== 3) problems.push(`${opened.windowsWhileOpen} windows while the opened one was up, not 3`)
        if (opened.size[0] !== 360 || opened.size[1] !== 240) problems.push(`the opened window is ${opened.size.join(" x ")}, not 360 x 240`)
        if (opened.position[0] !== 620 || opened.position[1] !== 140) problems.push(`the opened window is at ${opened.position.join(", ")}, not 620, 140`)
        if (!opened.devicePixelRatioMatchesNative) problems.push("devicePixelRatio is not the renderer's scale factor")
        if (!opened.openerIsTheFirstWindow) problems.push("the opened window's opener is not the first window")
        if (!opened.hasOwnTree) problems.push("the opened window does not hold its own tree")
        if (!opened.ownBodyHasContent) problems.push("the opened window's document.body is empty or the first window's")
        if (!opened.reusedByName) problems.push("window.open with the same name did not return the open window")
        if (opened.closeEvents.join(",") !== "beforeunload,pagehide,unload") problems.push(`close() fired ${opened.closeEvents.join(", ") || "nothing"}, not beforeunload, pagehide, unload`)
        if (opened.openedFromHandler !== "ok") problems.push(`window.open from a key handler: ${opened.openedFromHandler}`)
        if (!opened.closedAfterClose) problems.push("the window is not closed after close()")
        if (opened.windowsAfterClose !== 2) problems.push(`${opened.windowsAfterClose} windows after close(), not 2`)
        if (!opened.openerStillShowsUpdate) problems.push("the first window does not show a change made after the opened window closed")
      }
    }
    if (name === "unload-closes-last") {
      if (!report.closedRendererSawIt) problems.push("both windows were not closed, or the first one's onWindowClosed did not run once (the pagehide handler closing the second)")
    } else if (name !== "quit" && name !== "window-open") {
      if (report.windowsAfterClose !== 1) problems.push(`${report.windowsAfterClose} windows after one was closed, not 1`)
      if (!report.closedRendererSawIt) problems.push("the renderer of the closed window did not hear of it (isWindowClosed, onWindowClosed once)")
      if (!report.survivorStillOpen) problems.push("closing one window closed the other")
      if (!report.survivorRedrew) problems.push("the surviving window drew no frame for a change after the close")
      if (!report.survivorShowsUpdate) problems.push("the surviving window does not show the change made after the close")
      const closedCalls = report.closed === "alpha" ? report.windowClosedCalls.alpha : report.windowClosedCalls.beta
      const survivorCalls = report.closed === "alpha" ? report.windowClosedCalls.beta : report.windowClosedCalls.alpha
      if (closedCalls !== 1 || survivorCalls !== 0) problems.push(`onWindowClosed ran ${closedCalls} times for the closed window and ${survivorCalls} for the other`)
    }
    if (result === null) {
      problems.push(`the app was still running ${END_LIMIT_MS} ms after it was asked to end (onTerminated ${terminated ? "ran" : "did not run"})`)
    } else {
      if (result.code !== 0) problems.push(`exit status ${result.code}`)
      if (!terminated) problems.push("onTerminated did not run")
      else if (terminated.calls !== 1) problems.push(`onTerminated ran ${terminated.calls} times, not once`)
    }
    return { name, problems }
  } finally {
    if (app.exitCode === null) app.kill("SIGKILL")
    await app.exited
    current = null
    rmSync(folder, { recursive: true, force: true })
  }
}

async function main(): Promise<number> {
  mkdirSync(OUT, { recursive: true })
  const only = process.env.E2E_ONLY?.split(",")
  for (const name of only ?? []) {
    if (!CASES.includes(name as CaseName)) throw new Error(`E2E_ONLY names no case "${name}" (cases: ${CASES.join(", ")})`)
  }
  const results: Result[] = []
  for (const name of CASES) {
    if (only && !only.includes(name)) continue
    console.log(`\n== ${name}`)
    try {
      results.push(await runCase(name))
    } catch (error) {
      if (error instanceof NotCheckable) {
        console.log(`not checkable: ${error.message}`)
        return EXIT_NOT_CHECKABLE
      }
      throw error
    }
  }
  console.log("")
  for (const result of results) console.log(`${result.problems.length === 0 ? "PASS" : "FAIL"}  ${result.name}${result.problems.length === 0 ? "" : ": " + result.problems.join("; ")}`)
  const failed = results.filter((result) => result.problems.length > 0).length
  console.log(`\n${results.length - failed} of ${results.length} cases passed`)
  return failed === 0 ? EXIT_PASSED : EXIT_FAILED
}

main().then(
  (status) => process.exit(status),
  (error) => {
    console.error("the e2e could not run:", error)
    process.exit(EXIT_COULD_NOT_RUN)
  }
)
