import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import solidPlugin from "../bun-plugin.js"

const fixture = join(import.meta.dirname, "../../fixtures/consumer")
const workspace = resolve(import.meta.dirname, "../../../..")
const temp = mkdtempSync(join(tmpdir(), "ghia-solid-consumer-"))
const TIMEOUT_MS = 60_000

const tarballs = {
  "@ghia/native": { directory: "packages/native", filename: "ghia-native.tgz" },
  "@ghia/solid": { directory: "packages/solid", filename: "ghia-solid.tgz" },
  "@ghia/vite": { directory: "packages/vite", filename: "ghia-vite.tgz" },
}

const running: Bun.Subprocess[] = []

afterAll(async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL")
    await child.exited
  }
  rmSync(temp, { recursive: true, force: true })
})

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" })
  const output = result.stdout.toString() + result.stderr.toString()
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} exited ${result.exitCode}:\n${output}`)
  return output
}

function lines(output: string, prefix: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
}

async function waitForLine(command: string[], cwd: string, prefix: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  running.push(child)
  let output = ""
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true })
  }
  void collect(child.stdout)
  void collect(child.stderr)
  const deadline = Date.now() + TIMEOUT_MS
  while (!output.includes(prefix)) {
    if (child.exitCode !== null) throw new Error(`exited before "${prefix}":\n${output}`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for "${prefix}":\n${output}`)
    await Bun.sleep(50)
  }
  // Lets the rest of the line arrive before the process is stopped.
  await Bun.sleep(100)
  child.kill("SIGTERM")
  await child.exited
  return output
}

describe("Solid package consumer", () => {
  it("builds TSX with the exported Bun plugin", async () => {
    const result = await Bun.build({
      entrypoints: [join(fixture, "build-entry.tsx")],
      target: "bun",
      plugins: [solidPlugin],
      write: false,
    })
    expect(result.success, result.logs.join("\n")).toBe(true)
    const output = result.outputs[0]
    if (output === undefined) throw new Error("Bun.build produced no output")
    expect(await output.text()).toContain("built with plugin")
  })

  describe("installed from tarballs with pnpm, on Vite", () => {
    const ghia = join(temp, "node_modules", ".bin", "ghia")

    beforeAll(() => {
      for (const tarball of Object.values(tarballs)) {
        // `bun pm pack` only rewrites `workspace:^` for a Bun workspace, and the workspace is pnpm's.
        run(["pnpm", "pack", "--out", join(temp, tarball.filename), "--ignore-scripts"], join(workspace, tarball.directory))
      }
      const dependencies = Object.fromEntries(
        Object.entries(tarballs).map(([name, tarball]) => [name, `file:./${tarball.filename}`])
      )
      writeFileSync(join(temp, "package.json"), JSON.stringify({
        private: true,
        type: "module",
        dependencies: { ...dependencies, "solid-js": "1.9.15", vite: "^8.0.0" },
      }))
      // The packed packages depend on @ghia/native by version; this keeps them on the tarball, which
      // carries the workspace's addon. NAPI_RS_NATIVE_LIBRARY_PATH cannot stand in for it: it
      // overrides every napi-rs binding in the process, Vite's rolldown included.
      writeFileSync(
        join(temp, "pnpm-workspace.yaml"),
        `overrides:\n  "@ghia/native": "file:./${tarballs["@ghia/native"].filename}"\n`
      )
      for (const filename of ["main.tsx", "view.tsx", "tsconfig.json", "vite.config.ts"]) {
        cpSync(join(fixture, filename), join(temp, filename))
      }
      run(["pnpm", "install", "--prefer-offline", "--ignore-scripts"], temp)
    }, TIMEOUT_MS * 2)

    it("renders under ghia dev", async () => {
      const output = await waitForLine([ghia, "dev"], temp, "RENDERED")
      expect(lines(output, "RENDERED ")).toEqual(["consumer 2"])
      expect(lines(output, "IS_SERVER ")).toEqual(["false"])
    }, TIMEOUT_MS)

    it("builds with ghia build and runs with plain bun, without a preload", () => {
      run([ghia, "build"], temp)
      const output = run(["bun", join(temp, "dist", "main.js")], temp)
      expect(lines(output, "RENDERED ")).toEqual(["consumer 2"])
      expect(lines(output, "IS_SERVER ")).toEqual(["false"])
    }, TIMEOUT_MS)
  })
})
