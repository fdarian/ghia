import { describe, expect, it } from "vitest"
import { pruneDeadRefs } from "../css/weak-refs.js"

describe("pruneDeadRefs", () => {
  it("removes every dead reference, not only those before the first live one, and answers the first live target", () => {
    const first = { name: "first" }
    const second = { name: "second" }
    const dead = (): WeakRef<{ name: string }> => ({ deref: () => undefined, [Symbol.toStringTag]: "WeakRef" })
    const live = (target: { name: string }): WeakRef<{ name: string }> => new WeakRef(target)
    const refs = new Set([dead(), live(first), dead(), live(second), dead()])
    expect(pruneDeadRefs(refs)).toBe(first)
    expect(refs.size).toBe(2)
    expect([...refs].map((ref) => ref.deref())).toEqual([first, second])
  })

  it("empties a set with no live target and answers undefined", () => {
    const refs = new Set<WeakRef<object>>([{ deref: () => undefined, [Symbol.toStringTag]: "WeakRef" }])
    expect(pruneDeadRefs(refs)).toBeUndefined()
    expect(refs.size).toBe(0)
  })
})
