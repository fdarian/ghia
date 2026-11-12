import { afterEach, describe, expect, it } from "vitest"
import { registerRoot, unmountAllRoots } from "../roots.js"

const forget: Array<() => void> = []

afterEach(() => {
  for (const unregister of forget.splice(0)) unregister()
})

function register(unmount: () => void): () => void {
  const unregister = registerRoot(unmount)
  forget.push(unregister)
  return unregister
}

describe("unmountAllRoots", () => {
  it("unmounts every registered root", () => {
    const seen: string[] = []
    register(() => seen.push("a"))
    register(() => seen.push("b"))
    unmountAllRoots()
    expect(seen).toEqual(["a", "b"])
  })

  it("skips a root that unregistered itself, and one that does so while unmounting", () => {
    const seen: string[] = []
    const unregisterA = register(() => seen.push("a"))
    const unregisterB = register(() => {
      seen.push("b")
      unregisterB()
    })
    unregisterA()
    unmountAllRoots()
    unmountAllRoots()
    expect(seen).toEqual(["b"])
  })

  it("unmounts the roots after one that throws, then rethrows", () => {
    const seen: string[] = []
    const boom = new Error("boom")
    register(() => {
      throw boom
    })
    register(() => seen.push("after"))
    expect(() => unmountAllRoots()).toThrow(boom)
    expect(seen).toEqual(["after"])
  })
})
