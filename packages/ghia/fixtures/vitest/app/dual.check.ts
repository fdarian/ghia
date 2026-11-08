import { build } from "wrapper"
import { expect, test } from "vitest"

test("a dependency's own import of a package with browser and node builds resolves to the browser build", () => {
  expect(build).toBe("browser")
})

test("the dom globals are installed", () => {
  expect(globalThis.window).toBe(globalThis)
})
