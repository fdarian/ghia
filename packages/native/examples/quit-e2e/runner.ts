/** Runs each quit case against a fresh app process and prints a table. Exit status: 0 every case passed,
 *  1 a case failed, 2 the e2e could not run, 3 the machine gave the app no window to quit from. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { CASES, IDLE_MS, KILLER_PATH, OUT, QUIT_LIMIT_MS, READY_FILE, REQUEST_FILE, TERMINATED_FILE, type CaseName } from "./paths"

const EXIT_PASSED = 0
const EXIT_FAILED = 1
const EXIT_COULD_NOT_RUN = 2
const EXIT_NOT_CHECKABLE = 3

/** How long a case that did not end by itself is given before the runner kills the app it started. */
const GIVE_UP_MS = 6000

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

interface Result {
  name: CaseName
  pass: boolean
  detail: string
  latencyMs: number | null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function read(folder: string, file: string): { time: number; [key: string]: number } | null {
  const path = `${folder}/${file}`
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null
}

async function waitForFile(folder: string, file: string, exited: Promise<number>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let appExited = false
  void exited.then(() => (appExited = true))
  while (Date.now() < deadline) {
    const found = read(folder, file)
    if (found) return found
    if (appExited) throw new Error(`the app ended before it wrote ${file}`)
    await sleep(20)
  }
  throw new Error(`the app did not write ${file} within ${timeoutMs} ms`)
}

async function sendAppleEvent(pid: number): Promise<number> {
  const killer = Bun.spawn([KILLER_PATH, String(pid)], { stdout: "pipe", stderr: "inherit" })
  const requestedAt = Number((await new Response(killer.stdout).text()).trim())
  if ((await killer.exited) !== 0 || !Number.isFinite(requestedAt)) throw new Error("quit_killer did not send the quit Apple Event")
  return requestedAt
}

async function runCase(name: CaseName): Promise<Result> {
  const folder = mkdtempSync(`${tmpdir()}/gpuix-quit-e2e-${name}-`)
  const app = Bun.spawn(["bun", "app.tsx"], {
    env: { ...process.env, QUIT_E2E_CASE: name, QUIT_E2E_DIR: folder },
    stdout: "inherit",
    stderr: "inherit",
  })
  current = { app, folder }
  try {
    const ended = app.exited.then((code) => ({ code, at: Date.now() }))
    const ready = await waitForFile(folder, READY_FILE, app.exited, 30000)
    if (ready.windows === 0) throw new NotCheckable("the app's window never became visible (screen locked or asleep, or no window server session)")
    let requestedAt: number
    if (name === "apple-event" || name === "apple-event-server") {
      requestedAt = await sendAppleEvent(app.pid)
    } else {
      requestedAt = (await waitForFile(folder, REQUEST_FILE, app.exited, 5000)).time
    }
    const result = await Promise.race([ended, sleep(GIVE_UP_MS).then(() => null)])
    const terminated = read(folder, TERMINATED_FILE)
    if (result === null) {
      return { name, pass: false, latencyMs: null, detail: `the app was still running ${GIVE_UP_MS} ms after the request (onTerminated ${terminated ? "ran" : "did not run"})` }
    }
    const latencyMs = result.at - requestedAt
    const problems: string[] = []
    if (!terminated) problems.push("onTerminated did not run")
    if (result.code !== 0) problems.push(`exit status ${result.code}`)
    if (latencyMs > QUIT_LIMIT_MS) problems.push(`it took over the ${QUIT_LIMIT_MS} ms limit to end`)
    return {
      name,
      pass: problems.length === 0,
      latencyMs,
      detail: problems.length === 0 ? `onTerminated ran, exit status 0, process gone ${latencyMs.toFixed(0)} ms after the request` : `${problems.join("; ")} (exit status ${result.code}, process gone ${latencyMs.toFixed(0)} ms after the request)`,
    }
  } finally {
    if (app.exitCode === null) app.kill("SIGKILL")
    await app.exited
    current = null
    rmSync(folder, { recursive: true, force: true })
  }
}

async function main(): Promise<number> {
  if (!existsSync(KILLER_PATH)) throw new Error(`${KILLER_PATH} is not built: run run.sh`)
  mkdirSync(OUT, { recursive: true })
  const only = process.env.E2E_ONLY?.split(",")
  for (const name of only ?? []) {
    if (!CASES.includes(name as CaseName)) throw new Error(`E2E_ONLY names no case "${name}" (cases: ${CASES.join(", ")})`)
  }
  const results: Result[] = []
  for (const name of CASES) {
    if (only && !only.includes(name)) continue
    console.log(`\n== ${name}: a fresh app, idle ${IDLE_MS} ms, then one quit request`)
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
  for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.name}: ${result.detail}`)
  const failed = results.filter((result) => !result.pass).length
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
