/// `import ... from "react-dom"` in a Ghia app: `react()` points it at `@ghia/react/react-dom`, for
/// the app's own modules and for a package from node_modules, under `ghia dev` and under vitest.
/// The fixture app prints what a web library sees; the CLI and vitest run under Bun.

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { spawn } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..")
const GHIA_CLI = join(PACKAGE_ROOT, "node_modules", "ghia", "dist", "cli.js")
const SCRATCH_ROOT = join(PACKAGE_ROOT, "fixtures", "tmp")
const TIMEOUT_MS = 60_000

const EXPECTED_FACTS = [
  "portals library portal | own portal 0",
  "after setState false",
  "after flushSync true",
  "after the library's flushSync true",
  "namespace createPortal,default,flushSync,version",
  "library namespace createPortal,default,flushSync,version",
  "library default createPortal,flushSync,version",
  "version true",
]

let appDir: string

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  appDir = mkdtempSync(join(SCRATCH_ROOT, "react-dom-app-"))
  cpSync(join(PACKAGE_ROOT, "fixtures", "react-dom-app"), appDir, { recursive: true })
  // Installed as from npm: vitest and Vite treat node_modules differently from the app's own files.
  cpSync(join(PACKAGE_ROOT, "fixtures", "react-dom-lib"), join(appDir, "node_modules", "react-dom-lib"), { recursive: true })
})

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true })
})

/** Runs `command` until it exits, or, with `until`, until it has printed that text, and returns what it printed. */
function run(command: string[], until?: string): Promise<string> {
  // The marker makes `ghia` configure for tests when it is inherited; the CLI clears it, and so does this.
  const environment = { ...process.env }
  delete environment.VITEST
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd: appDir, env: environment, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (until !== undefined && output.includes(until)) {
        child.kill("SIGKILL")
        resolve(output)
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.once("exit", (code) => {
      if (until === undefined && code === 0) resolve(output)
      else reject(new Error(`${command.join(" ")} exited ${code}:\n${output}`))
    })
  })
}

function facts(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("FACT "))
    .map((line) => line.slice("FACT ".length))
}

describe("react-dom in a Ghia app", () => {
  test(
    "resolves to @ghia/react/react-dom under ghia dev, for the app and for a package in node_modules",
    async () => {
      const output = await run(["bun", GHIA_CLI, "dev"], "FACT version")
      expect(facts(output)).toEqual(EXPECTED_FACTS)
    },
    TIMEOUT_MS * 2
  )

  test(
    "resolves to @ghia/react/react-dom in a ghia build",
    async () => {
      await run(["bun", GHIA_CLI, "build", "--no-compile"])
      const output = await run(["bun", join(appDir, "dist", "main.js")])
      expect(facts(output)).toEqual(EXPECTED_FACTS)
    },
    TIMEOUT_MS * 2
  )

  test(
    "resolves to @ghia/react/react-dom under vitest, for the app and for a package in node_modules",
    async () => {
      await run(["bun", "--bun", "vitest", "run"])
      expect(readFileSync(join(appDir, "facts.txt"), "utf8").split("\n")).toEqual(EXPECTED_FACTS)
    },
    TIMEOUT_MS * 2
  )
})
