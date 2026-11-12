import { describe, expect, it } from "vitest"
import { runAll } from "../run-all.js"

describe("runAll", () => {
  it("runs every item and returns when none throws", () => {
    const seen: number[] = []
    runAll([1, 2, 3], (item) => seen.push(item), "failed")
    expect(seen).toEqual([1, 2, 3])
  })

  it("runs the items after a throw and rethrows the one error as it was", () => {
    const boom = new Error("boom")
    const seen: number[] = []
    expect(() =>
      runAll([1, 2, 3], (item) => {
        seen.push(item)
        if (item === 2) throw boom
      }, "failed")
    ).toThrow(boom)
    expect(seen).toEqual([1, 2, 3])
  })

  it("rethrows several errors as an AggregateError in order", () => {
    const first = new Error("first")
    const second = new Error("second")
    let caught: unknown
    try {
      runAll([first, second], (error) => {
        throw error
      }, "failed")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([first, second])
    expect((caught as AggregateError).message).toBe("failed")
  })
})
