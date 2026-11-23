import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { hasNativeTestRenderer } from "../testing.js"

const nativePackageDir = fileURLToPath(new URL("../..", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/dispose-leaving-close-queued.ts", import.meta.url))

const describeNative = hasNativeTestRenderer && process.platform === "darwin" ? describe : describe.skip

describeNative("a test renderer's window close", () => {
  // The panic is in a callback that napi cannot unwind through, so it aborts the process: the
  // test has to run in one of its own.
  it("does not touch the app of a renderer that was disposed before the close ran", () => {
    const result = spawnSync("bun", [fixture], { cwd: nativePackageDir, encoding: "utf8", timeout: 60_000 })
    expect(result.stderr).not.toContain("app was released before async operation completed")
    expect(result.status, result.stderr || result.error?.message).toBe(0)
    expect(result.stdout).toContain("survived")
  }, 90_000)
})
