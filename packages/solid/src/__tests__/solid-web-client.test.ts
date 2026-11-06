import { describe, expect, it } from "bun:test"
import { isServer } from "solid-js/web"

describe("solid-js/web under the preload", () => {
  it("loads Solid's client build, so isServer is false", () => {
    expect(isServer).toBe(false)
  })
})
