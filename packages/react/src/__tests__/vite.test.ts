/// `react()` under `ghia dev` and `ghia build`: JSX through @ghia/react, and Fast Refresh in Bun's
/// module runner. The fixture app prints what it renders, and each test edits its files while
/// `ghia dev` runs. The CLI runs under Bun; the tests themselves run under Node or Bun.

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { spawn as spawnProcess, type ChildProcess } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..")
const GHIA_CLI = join(PACKAGE_ROOT, "node_modules", "ghia", "dist", "cli.js")
const SCRATCH_ROOT = join(PACKAGE_ROOT, "fixtures", "tmp")
const TIMEOUT_MS = 30_000

type Run = {
  readonly process: ChildProcess
  readonly output: () => string
  waitFor(text: string, occurrences?: number): Promise<void>
}

const running: ChildProcess[] = []
let appDir: string

function spawn(command: string[]): Run {
  // The marker makes `ghia` configure for tests when it is inherited; the CLI clears it, and so does this.
  const environment = { ...process.env }
  delete environment.VITEST
  const child = spawnProcess(command[0], command.slice(1), { cwd: appDir, env: environment, stdio: ["ignore", "pipe", "pipe"] })
  running.push(child)
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()))
  return {
    process: child,
    output: () => output,
    async waitFor(text, occurrences = 1) {
      const deadline = Date.now() + TIMEOUT_MS
      while (output.split(text).length - 1 < occurrences) {
        if (child.exitCode !== null) throw new Error(`exited before "${text}":\n${output}`)
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${text}":\n${output}`)
        await sleep(50)
      }
    },
  }
}

async function runToExit(command: string[]): Promise<string> {
  const run = spawn(command)
  const code = await new Promise((resolve) => run.process.once("exit", resolve))
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}:\n${run.output()}`)
  return run.output()
}

function lines(output: string, prefix: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
}

function count(output: string, prefix: string): number {
  return lines(output, prefix).length
}

function editFile(file: string, from: string, to: string): void {
  const path = join(appDir, file)
  const source = readFileSync(path, "utf8")
  if (!source.includes(from)) throw new Error(`${file} has no "${from}"`)
  writeFileSync(path, source.replace(from, to))
}

/** The same app with `react()`'s injected first import of the refresh runtime left out. */
function writeConfigWithoutRuntimeSetup(): string {
  const file = "vite.config.no-setup.ts"
  writeFileSync(
    join(appDir, file),
    `import { defineConfig } from "vite"
import { ghia } from "ghia"
import { react } from "@ghia/react/vite"

const plugins = react()
const setup = plugins.find((plugin) => plugin.name === "ghia:react-refresh")
if (setup === undefined) throw new Error("react() has no ghia:react-refresh plugin")
delete setup.transform

export default defineConfig({ plugins: [ghia({ entry: "main.tsx" }), plugins] })
`
  )
  return file
}

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  appDir = mkdtempSync(join(SCRATCH_ROOT, "refresh-app-"))
  cpSync(join(PACKAGE_ROOT, "fixtures", "refresh-app"), appDir, { recursive: true })
})

afterEach(async () => {
  for (const child of running.splice(0)) {
    if (child.exitCode !== null) continue
    const exited = new Promise((resolve) => child.once("exit", resolve))
    child.kill("SIGKILL")
    await exited
  }
  rmSync(appDir, { recursive: true, force: true })
})

describe("react() under ghia dev", () => {
  test(
    "renders JSX through @ghia/react with the test renderer",
    async () => {
      const run = spawn(["bun", GHIA_CLI, "dev"])
      await run.waitFor("RENDERED")
      // The click in the entry made the count 1, so the Counter's state and its handler work.
      expect(lines(run.output(), "RENDERED ")).toEqual(["label v1 1"])
    },
    TIMEOUT_MS * 2
  )

  test(
    "applies an edit to a component module as a Fast Refresh update, keeping the state of the components around it",
    async () => {
      const run = spawn(["bun", GHIA_CLI, "dev"])
      await run.waitFor("RENDERED label v1 1")
      editFile("label.tsx", "label v1", "label v2")
      await run.waitFor("UPDATED label v2 1")
      await sleep(500)

      expect(run.process.exitCode).toBeNull()
      expect(count(run.output(), "ENTRY_RUN")).toBe(1)
      expect(lines(run.output(), "UPDATED ")).toEqual(["label v2 1"])
    },
    TIMEOUT_MS * 2
  )

  test(
    "keeps the state of the edited component too, when only its markup changes",
    async () => {
      const run = spawn(["bun", GHIA_CLI, "dev"])
      await run.waitFor("RENDERED label v1 1")
      editFile("counter.tsx", "width: 200", "width: 220")
      await sleep(1000)
      editFile("label.tsx", "label v1", "label v2")
      await run.waitFor("UPDATED label v2 1")

      expect(count(run.output(), "ENTRY_RUN")).toBe(1)
    },
    TIMEOUT_MS * 2
  )

  test.each([1, 2])(
    "still refreshes a component edit after %i full reload(s) of the entry",
    async (reloads) => {
      const run = spawn(["bun", GHIA_CLI, "dev"])
      await run.waitFor("RENDERED label v1 1")
      for (let reload = 1; reload <= reloads; reload++) {
        editFile("main.tsx", `entry v${reload}`, `entry v${reload + 1}`)
        await run.waitFor(`ENTRY_RUN entry v${reload + 1}`)
      }
      await run.waitFor("RENDERED label v1 1", reloads + 1)

      editFile("label.tsx", "label v1", "label v2")
      await run.waitFor("UPDATED label v2 1")

      expect(count(run.output(), "ENTRY_RUN")).toBe(reloads + 1)
    },
    TIMEOUT_MS * 2
  )

  test(
    "fails loudly at the first component when the refresh runtime was never set up",
    async () => {
      const run = spawn(["bun", GHIA_CLI, "dev", "--config", writeConfigWithoutRuntimeSetup()])
      await run.waitFor("can't detect preamble")

      expect(run.output()).not.toContain("RENDERED")
    },
    TIMEOUT_MS * 2
  )
})

describe("react() under ghia build", () => {
  test(
    "builds a bundle that renders with plain bun, without the refresh runtime",
    async () => {
      await runToExit(["bun", GHIA_CLI, "build", "--no-compile"])
      const output = await runToExit(["bun", join(appDir, "dist", "main.js")])
      expect(lines(output, "RENDERED ")).toEqual(["label v1 1"])
      expect(readFileSync(join(appDir, "dist", "main.js"), "utf8")).not.toContain("RefreshRuntime")
    },
    TIMEOUT_MS * 2
  )
})
