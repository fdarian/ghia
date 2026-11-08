import { describe, expect, test } from "bun:test"
import { NATIVE_LOADER_FILTER, patchNativeLoader } from "../../dist/compile.js"

const LOADER = `import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const { readFileSync } = require('fs')
`

describe("patchNativeLoader", () => {
  test("deletes the createRequire line and keeps the rest", () => {
    expect(patchNativeLoader(LOADER, "index.js")).toBe(`import { createRequire } from 'module'

const { readFileSync } = require('fs')
`)
  })

  test("throws a clear error when the line is missing", () => {
    expect(() => patchNativeLoader("const { readFileSync } = require('fs')\n", "/x/@ghia/native/index.js")).toThrow(
      "/x/@ghia/native/index.js no longer contains `const require = createRequire(import.meta.url)`: the napi-rs loader changed shape"
    )
  })
})

describe("NATIVE_LOADER_FILTER", () => {
  test.each([
    "/app/node_modules/.pnpm/@ghia+native@0.11.1/node_modules/@ghia/native/index.js",
    "/app/node_modules/@ghia/native/index.js",
    "/repo/packages/native/index.js",
  ])("matches %s", (path) => {
    expect(NATIVE_LOADER_FILTER.test(path)).toBe(true)
  })

  test.each(["/repo/packages/native/browser.mjs", "/repo/packages/solid/index.js", "/app/node_modules/@ghia/native/js/index.js"])(
    "leaves %s alone",
    (path) => {
      expect(NATIVE_LOADER_FILTER.test(path)).toBe(false)
    }
  )
})
