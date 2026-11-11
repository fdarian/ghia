import { describe, expect, it } from "vitest"
import { copyPrototypeMembers } from "../dom/prototype-members.js"

describe("copyPrototypeMembers", () => {
  it("copies methods, getters and symbols but not the constructor", () => {
    const tag = Symbol("tag")
    class Source {
      #hidden = 1
      get value(): number {
        return this.#hidden
      }
      greet(): string {
        return "hi"
      }
      [tag](): string {
        return "tagged"
      }
    }
    class Target {}
    copyPrototypeMembers(Source.prototype, Target.prototype)
    const copy = new Target() as unknown as { greet(): string; [tag](): string }
    expect(copy.greet()).toBe("hi")
    expect(copy[tag]()).toBe("tagged")
    expect(Object.getOwnPropertyDescriptor(Target.prototype, "value")?.get).toBe(
      Object.getOwnPropertyDescriptor(Source.prototype, "value")?.get
    )
    expect(Target.prototype.constructor).toBe(Target)
  })
})
