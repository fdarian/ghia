/**
 * A Ghia gap, pinned: `@solidjs/router` reads `window.history.state` when it is imported (`saveCurrentDepth`), and Ghia
 * has no `window.history`. When `history` exists this test fails, and `solid-router.test.tsx` can drop its stand-in.
 */
import { describe, expect, it } from "vitest"
import { hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("@solidjs/router without window.history", () => {
  it.fails("imports", async () => {
    expect("history" in globalThis.window).toBe(true)
    await import("@solidjs/router")
  })
})
