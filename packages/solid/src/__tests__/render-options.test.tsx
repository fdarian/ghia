import { afterEach, describe, expect, it, vi } from "vitest"
import { TestRenderer, hasNativeTestRenderer } from "@ghia/native/testing"
import { render, resetRender } from "../renderer.js"

const created = vi.hoisted(() => ({ onErrors: [] as Array<(error: unknown) => void> }))

vi.mock("@ghia/native/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghia/native/runtime")>()),
  // The real one opens a window on `init()`; a test renderer is not a GpuixRenderer, so render() skips that.
  createNativeRenderer: (options: { onError: (error: unknown) => void }) => {
    created.onErrors.push(options.onError)
    return new TestRenderer()
  },
}))

afterEach(() => {
  resetRender()
  created.onErrors.length = 0
})

describe.skipIf(!hasNativeTestRenderer)("render() options", () => {
  it("reports a native error to the onUncaughtError of the latest render", () => {
    const first = vi.fn()
    const second = vi.fn()
    render(() => <text>one</text>, { onUncaughtError: first })
    render(() => <text>two</text>, { onUncaughtError: second })

    expect(created.onErrors).toHaveLength(1)
    const failure = new Error("native failure")
    created.onErrors[0](failure)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0][0]).toBe(failure)
  })

  it("stops reporting when the latest render has no onUncaughtError", () => {
    const first = vi.fn()
    render(() => <text>one</text>, { onUncaughtError: first })
    render(() => <text>two</text>)

    created.onErrors[0](new Error("native failure"))

    expect(first).not.toHaveBeenCalled()
  })
})
