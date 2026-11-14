import { afterEach, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..")
const FIXTURE_ROOT = join(PACKAGE_ROOT, "fixtures", "vitest")
const SCRATCH_ROOT = join(PACKAGE_ROOT, "fixtures", "tmp")
const TIMEOUT_MS = 60_000

let appDir: string

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true })
})

test(
  "a dependency of an installed package, whose exports list the node build first, resolves to its browser build",
  async () => {
    mkdirSync(SCRATCH_ROOT, { recursive: true })
    appDir = mkdtempSync(join(SCRATCH_ROOT, "vitest-"))
    cpSync(join(FIXTURE_ROOT, "app"), appDir, { recursive: true })
    // Installed packages: vitest externalizes them unless told otherwise, and Node then resolves
    // what `wrapper` imports with the `node` condition.
    for (const name of ["wrapper", "dual-build", "conditional"]) {
      cpSync(join(FIXTURE_ROOT, name), join(appDir, "node_modules", name), { recursive: true })
    }

    const run = Bun.spawn(["bun", "--bun", "vitest", "run"], {
      cwd: appDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = (await new Response(run.stdout).text()) + (await new Response(run.stderr).text())
    expect(await run.exited, output).toBe(0)
  },
  TIMEOUT_MS
)
