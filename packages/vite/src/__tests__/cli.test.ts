import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..")
const CLI = join(PACKAGE_ROOT, "dist", "cli.js")
const SCRATCH_ROOT = join(PACKAGE_ROOT, "fixtures", "tmp")
const TIMEOUT_MS = 30_000

interface Run {
  readonly process: Bun.Subprocess<"ignore", "pipe", "pipe">
  readonly output: () => string
  waitFor(text: string): Promise<void>
}

const running: Bun.Subprocess[] = []
let appDir: string

function spawn(command: string[], cwd: string): Run {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
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

async function runToExit(command: string[], cwd: string): Promise<string> {
  const run = spawn(command, cwd)
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

function writeBareConfig(options: { inject: boolean }): string {
  const file = options.inject ? "vite.config.bare.ts" : "vite.config.bare-no-inject.ts"
  writeFileSync(
    join(appDir, file),
    `import { defineConfig } from "vite"
import { ghia } from "@ghia/vite"

const plugin = ghia({ entry: "bare.ts" })
${options.inject ? "" : "delete plugin.transform"}

export default defineConfig({ plugins: [plugin] })
`
  )
  return file
}

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  appDir = mkdtempSync(join(SCRATCH_ROOT, "app-"))
  cpSync(join(PACKAGE_ROOT, "fixtures", "app"), appDir, {
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

describe("ghia dev", () => {
  test(
    "installs the globals before the first import evaluates",
    async () => {
      const run = spawn(["bun", CLI, "dev"], appDir)
      await run.waitFor("RENDERED marker v1")
      expect(lines(run.output(), "WINDOW_AT_LOAD ")).toEqual(["object"])
      expect(lines(run.output(), "IS_SERVER ")).toEqual(["false"])
    },
    TIMEOUT_MS * 2
  )

  test(
    "leaves window undefined without the entry transform",
    async () => {
      const run = spawn(["bun", CLI, "dev", "--config", writeBareConfig({ inject: false })], appDir)
      await run.waitFor("WINDOW_AT_LOAD")
      expect(lines(run.output(), "WINDOW_AT_LOAD ")).toEqual(["undefined"])
    },
    TIMEOUT_MS * 2
  )

  test(
    "defines window with the entry transform, for an entry that imports nothing from ghia",
    async () => {
      const run = spawn(["bun", CLI, "dev", "--config", writeBareConfig({ inject: true })], appDir)
      await run.waitFor("WINDOW_AT_LOAD")
      expect(lines(run.output(), "WINDOW_AT_LOAD ")).toEqual(["object"])
    },
    TIMEOUT_MS * 2
  )

  test(
    "re-runs the entry when it is edited, in the same process",
    async () => {
      const run = spawn(["bun", CLI, "dev"], appDir)
      await run.waitFor("RENDERED marker v1")

      const entry = join(appDir, "main.ts")
      writeFileSync(entry, readFileSync(entry, "utf8").replace("marker v1", "marker v2"))
      await run.waitFor("RENDERED marker v2")

      expect(run.process.exitCode).toBeNull()
      expect(lines(run.output(), "RENDERED ")).toEqual(["marker v1", "marker v2"])
    },
    TIMEOUT_MS * 2
  )

  test(
    "stops on SIGTERM",
    async () => {
      const run = spawn(["bun", CLI, "dev"], appDir)
      await run.waitFor("RENDERED marker v1")
      run.process.kill("SIGTERM")
      expect(await run.process.exited).toBe(0)
    },
    TIMEOUT_MS * 2
  )
})

describe("ghia build", () => {
  test(
    "builds a bundle that runs with plain bun",
    async () => {
      await runToExit(["bun", CLI, "build"], appDir)
      const output = await runToExit(["bun", join(appDir, "dist", "main.js")], appDir)
      expect(lines(output, "WINDOW_AT_LOAD ")).toEqual(["object"])
      expect(lines(output, "IS_SERVER ")).toEqual(["false"])
      expect(lines(output, "RENDERED ")).toEqual(["marker v1"])
    },
    TIMEOUT_MS * 2
  )

  test.each([
    { inject: false, windowAtLoad: "undefined" },
    { inject: true, windowAtLoad: "object" },
  ])(
    "for an entry that imports nothing from ghia, the entry transform decides window (inject: $inject)",
    async (variant) => {
      await runToExit(["bun", CLI, "build", "--config", writeBareConfig(variant)], appDir)
      const output = await runToExit(["bun", join(appDir, "dist", "main.js")], appDir)
      expect(lines(output, "WINDOW_AT_LOAD ")).toEqual([variant.windowAtLoad])
    },
    TIMEOUT_MS * 2
  )
})
