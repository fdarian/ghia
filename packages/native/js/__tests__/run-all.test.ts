import { describe, expect, it } from "vitest"
import { runAll, runSteps, runThenAlways } from "../run-all.js"

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

describe("runSteps", () => {
  it("runs the steps after a throw", () => {
    const seen: string[] = []
    const boom = new Error("boom")
    expect(() =>
      runSteps([
        () => {
          throw boom
        },
        () => seen.push("second"),
      ], "failed")
    ).toThrow(boom)
    expect(seen).toEqual(["second"])
  })
})

describe("runThenAlways", () => {
  it("returns the body's value after running after", () => {
    const seen: string[] = []
    const value = runThenAlways(() => {
      seen.push("body")
      return 7
    }, () => seen.push("after"), "failed")
    expect(value).toBe(7)
    expect(seen).toEqual(["body", "after"])
  })

  it("runs after when the body throws and rethrows the body's error alone", () => {
    const boom = new Error("boom")
    let ran = false
    expect(() =>
      runThenAlways(() => {
        throw boom
      }, () => {
        ran = true
      }, "failed")
    ).toThrow(boom)
    expect(ran).toBe(true)
  })

  it("throws the error of after when the body returned", () => {
    const boom = new Error("boom")
    expect(() =>
      runThenAlways(() => 1, () => {
        throw boom
      }, "failed")
    ).toThrow(boom)
  })

  it("keeps both errors when the body and after throw", () => {
    const first = new Error("first")
    const second = new Error("second")
    let caught: unknown
    try {
      runThenAlways(() => {
        throw first
      }, () => {
        throw second
      }, "failed")
    } catch (error) {
      caught = error
    }
    expect((caught as AggregateError).errors).toEqual([first, second])
  })
})
