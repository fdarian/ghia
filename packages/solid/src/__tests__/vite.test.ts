import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..")
const GHIA_CLI = join(PACKAGE_ROOT, "node_modules", "ghia", "dist", "cli.js")
const SCRATCH_ROOT = join(PACKAGE_ROOT, "fixtures", "tmp")
const TIMEOUT_MS = 30_000

interface Run {
  readonly process: Bun.Subprocess<"ignore", "pipe", "pipe">
  readonly output: () => string
  waitFor(text: string): Promise<void>
}

const running: Bun.Subprocess[] = []
let appDir: string

function spawn(command: string[]): Run {
  const child = Bun.spawn(command, { cwd: appDir, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  running.push(child)
  let output = ""
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true })
  }
  void collect(child.stdout)
  void collect(child.stderr)
  return {
    process: child,
    output: () => output,
    async waitFor(text) {
      const deadline = Date.now() + TIMEOUT_MS
      while (!output.includes(text)) {
        if (child.exitCode !== null) throw new Error(`exited before "${text}":\n${output}`)
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${text}":\n${output}`)
        await Bun.sleep(50)
      }
    },
  }
}

async function runToExit(command: string[]): Promise<string> {
  const run = spawn(command)
  const code = await run.process.exited
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}:\n${run.output()}`)
  return run.output()
}

function lines(output: string, prefix: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
}

function count(output: string, line: string): number {
  return output.split("\n").filter((candidate) => candidate === line).length
}

function editLabel(): void {
  const label = join(appDir, "label.tsx")
  writeFileSync(label, readFileSync(label, "utf8").replace("label v1", "label v2"))
}

/** The same app, compiled by vite-plugin-solid alone: universal output without solid-refresh. */
function writeConfigWithoutRefresh(): string {
  const file = "vite.config.no-refresh.ts"
  writeFileSync(
    join(appDir, file),
    `import { defineConfig } from "vite"
import { ghia } from "ghia"
import vitePluginSolid from "vite-plugin-solid"

export default defineConfig({
  plugins: [
    ghia({ entry: "main.tsx" }),
    vitePluginSolid({ solid: { generate: "universal", moduleName: "@ghia/solid" } }),
  ],
})
`
  )
  return file
}

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  appDir = mkdtempSync(join(SCRATCH_ROOT, "vite-app-"))
  cpSync(join(PACKAGE_ROOT, "fixtures", "vite-app"), appDir, {
    recursive: true,
    filter: (source) => !source.endsWith("/dist"),
  })
})

afterEach(async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL")
    await child.exited
  }
  rmSync(appDir, { recursive: true, force: true })
})

describe("solid() under ghia dev", () => {
  test(
    "renders JSX through the universal renderer, with one solid-js for the app and @ghia/solid",
    async () => {
      const run = spawn(["bun", GHIA_CLI, "dev"])
      await run.waitFor("RENDERED")
      // 2 is set by the app's signal after the first render; a second solid-js would not track it.
      expect(lines(run.output(), "RENDERED ")).toEqual(["label v1 2"])
      expect(lines(run.output(), "IS_SERVER ")).toEqual(["false"])
      expect(run.output()).not.toContain("multiple instances of Solid")
    },
    TIMEOUT_MS * 2
  )

  test(
    "applies an edit to a component module as a hot update, without re-running the entry",
    async () => {
      const run = spawn(["bun", GHIA_CLI, "dev"])
      await run.waitFor("RENDERED label v1 2")
      editLabel()
      await run.waitFor("UPDATED label v2 2")
      await Bun.sleep(500)

      expect(run.process.exitCode).toBeNull()
      expect(count(run.output(), "ENTRY_RUN")).toBe(1)
      expect(lines(run.output(), "UPDATED ")).toEqual(["label v2 2"])
    },
    TIMEOUT_MS * 2
  )

  test(
    "re-runs the entry on the same edit without solid-refresh",
    async () => {
      const run = spawn(["bun", GHIA_CLI, "dev", "--config", writeConfigWithoutRefresh()])
      await run.waitFor("RENDERED label v1 2")
      editLabel()
      await run.waitFor("RENDERED label v2 2")

      expect(count(run.output(), "ENTRY_RUN")).toBe(2)
    },
    TIMEOUT_MS * 2
  )
})

describe("solid() under ghia build", () => {
  test(
    "builds a bundle that renders with plain bun and Solid's client runtime",
    async () => {
      await runToExit(["bun", GHIA_CLI, "build"])
      const output = await runToExit(["bun", join(appDir, "dist", "main.js")])
      expect(lines(output, "RENDERED ")).toEqual(["label v1 2"])
      expect(lines(output, "IS_SERVER ")).toEqual(["false"])
      expect(readFileSync(join(appDir, "dist", "main.js"), "utf8")).not.toContain("solid-refresh")
    },
    TIMEOUT_MS * 2
  )
})
