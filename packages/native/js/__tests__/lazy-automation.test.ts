import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"

const temp = mkdtempSync(join(tmpdir(), "gpuix-lazy-automation-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

interface MetafileOutput {
  inputs: Record<string, unknown>
  imports: Array<{ path: string; kind: string }>
  entryPoint?: string
}

const AUTOMATION_DEPENDENCIES = ["/node_modules/zod/", "/node_modules/eventsource-parser/"]

/** Bundles `entry` with code splitting, so a dynamic import becomes its own chunk, and
 *  returns the inputs of the entry chunk and of every chunk it imports statically. */
function staticInputs(entry: string): { staticInputs: string[]; allInputs: string[] } {
  const outdir = mkdtempSync(join(temp, "out-"))
  const metafile = join(outdir, "meta.json")
  const result = spawnSync(
    "bun",
    [
      "build",
      fileURLToPath(new URL(`../${entry}`, import.meta.url)),
      "--target=node",
      "--format=esm",
      "--splitting",
      "--external",
      "@ghia/native",
      "--outdir",
      join(outdir, "bundle"),
      `--metafile=${metafile}`,
    ],
    { encoding: "utf8" }
  )
  expect(result.status, result.stderr).toBe(0)
  const outputs = (JSON.parse(readFileSync(metafile, "utf8")) as {
    outputs: Record<string, MetafileOutput>
  }).outputs
  const entryOutput = Object.keys(outputs).find((name) => outputs[name]!.entryPoint !== undefined)
  expect(entryOutput).toBeDefined()

  const reached = new Set<string>()
  const pending = [entryOutput!]
  while (pending.length > 0) {
    const name = pending.pop()!
    if (reached.has(name)) continue
    reached.add(name)
    for (const edge of outputs[name]!.imports) {
      if (edge.kind === "import-statement" && edge.path in outputs) pending.push(edge.path)
    }
  }
  const inputsOf = (names: Iterable<string>) => [...names].flatMap((name) => Object.keys(outputs[name]!.inputs))
  return { staticInputs: inputsOf(reached), allInputs: inputsOf(Object.keys(outputs)) }
}

function automationDependencies(inputs: string[]): string[] {
  return inputs.filter((input) => AUTOMATION_DEPENDENCIES.some((dependency) => input.includes(dependency)))
}

describe("automation is loaded on demand", () => {
  it("finds zod when the automation client is the entry", () => {
    const graph = staticInputs("automation/client.ts")
    expect(automationDependencies(graph.staticInputs).length).toBeGreaterThan(0)
  })

  it("keeps zod and eventsource-parser out of what the runtime loads at import time", () => {
    const graph = staticInputs("runtime.ts")
    expect(automationDependencies(graph.staticInputs)).toEqual([])
    // The client is still bundled, as a chunk that enableAutomation imports when it runs.
    expect(automationDependencies(graph.allInputs).length).toBeGreaterThan(0)
  })

  it.each(["host.ts", "screen.ts", "testing.ts", "cpu-throttle.ts", "idle-gc.ts"])(
    "keeps zod out of %s",
    (entry) => {
      expect(automationDependencies(staticInputs(entry).staticInputs)).toEqual([])
    }
  )
})
