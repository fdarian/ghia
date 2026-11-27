import { afterEach, describe, expect, it, vi } from "vitest"
import { render, resetRender } from "../reconciler/renderer.js"

const mocks = vi.hoisted(() => ({
  startFrameLoop: vi.fn(() => ({ stop: () => {} })),
}))

vi.mock("@ghia/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghia/native")>()),
  // The mock throws on a key it lacks, and web-build.ts reads this one.
  webBuild: false,
  GpuixRenderer: class {
    init() {}
  },
}))

vi.mock("@ghia/native/runtime", async (importOriginal) => {
  const GpuixRenderer = (await import("@ghia/native")).GpuixRenderer
  return {
    ...(await importOriginal<typeof import("@ghia/native/runtime")>()),
    createNativeRenderer: () => new GpuixRenderer(() => {}),
    startFrameLoop: mocks.startFrameLoop,
  }
})

vi.mock("../reconciler/reconciler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reconciler/reconciler.js")>()),
  createRoot: () => {
    throw new Error("mount failed")
  },
}))

afterEach(() => {
  resetRender()
  mocks.startFrameLoop.mockClear()
})

describe("render() when the mount throws", () => {
  it("still starts the frame loop of the window it opened, and rethrows", () => {
    expect(() => render(<div>one</div>)).toThrow("mount failed")
    expect(mocks.startFrameLoop).toHaveBeenCalledTimes(1)
  })
})
