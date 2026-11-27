import { afterEach, describe, expect, it, vi } from "vitest"
import { render, resetRender } from "../renderer.js"

const mocks = vi.hoisted(() => ({
  startFrameLoop: vi.fn(() => ({ stop: () => {} })),
}))

vi.mock("@ghia/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghia/native")>()),
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

vi.mock("../root.js", () => ({
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
    expect(() => render(() => <div>one</div>)).toThrow("mount failed")
    expect(mocks.startFrameLoop).toHaveBeenCalledTimes(1)
  })
})
