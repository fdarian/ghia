import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { hasNativeTestRenderer } from "../testing.js"

const nativePackageDir = fileURLToPath(new URL("../..", import.meta.url))
const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url))

const describeNative = hasNativeTestRenderer && process.platform === "darwin" ? describe : describe.skip

// The panic is in a callback that napi cannot unwind through, so it aborts the process: each test
// has to run in one of its own.
function runFixture(name: string, ...args: string[]) {
  const result = spawnSync("bun", [`${fixtureDir}${name}`, ...args], { cwd: nativePackageDir, encoding: "utf8", timeout: 60_000 })
  expect(result.stderr).not.toContain("app was released before async operation completed")
  expect(result.status, result.stderr || result.error?.message).toBe(0)
  expect(result.stdout).toContain("survived")
}

describeNative("a test window's close", () => {
  it("does not touch the app of a renderer that was disposed before the close ran", () => {
    runFixture("dispose-leaving-close-queued.ts")
  }, 90_000)

  it.each(["dispose", "replace"])("does not touch the app of a RowOracle that was %sd before the close ran", (mode) => {
    runFixture("oracle-close-queued.ts", mode)
  }, 90_000)
})
