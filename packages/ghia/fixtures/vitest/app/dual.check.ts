import { build } from "wrapper"
import { build as conditionalBuild } from "conditional"
import { expect, test } from "vitest"

test("a dependency's own import of a package with browser and node builds resolves to the browser build", () => {
  expect(build).toBe("browser")
})

test("the dom globals are installed", () => {
  expect(globalThis.window).toBe(globalThis)
})

test("a condition another plugin added stays, so a package's source build under it resolves", () => {
  expect(conditionalBuild).toBe("custom")
})
