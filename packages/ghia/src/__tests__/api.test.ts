import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { build, dev } from "../../dist/index.js"

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..")
const SCRATCH_ROOT = join(PACKAGE_ROOT, "fixtures", "tmp")
const TIMEOUT_MS = 60_000

let appDir: string

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  appDir = mkdtempSync(join(SCRATCH_ROOT, "api-"))
  cpSync(join(PACKAGE_ROOT, "fixtures", "app"), appDir, { recursive: true })
})

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true })
})

function writeEntrylessConfig(): string {
  writeFileSync(
    join(appDir, "vite.config.entryless.ts"),
    `import { defineConfig } from "vite"
import { ghia } from "ghia"

export default defineConfig({ plugins: [ghia()] })
`
  )
  return join(appDir, "vite.config.entryless.ts")
}

describe("build()", () => {
  test(
    "emits dist/main.js under the root it is given",
    async () => {
      await build({ root: appDir, compile: false })
      expect(existsSync(join(appDir, "dist", "main.js"))).toBe(true)
      expect(existsSync(join(appDir, "dist", "server.js"))).toBe(false)
    },
    TIMEOUT_MS
  )

  test(
    "rejects when the plugin has no entry",
    async () => {
      await expect(build({ root: appDir, configFile: writeEntrylessConfig(), compile: false })).rejects.toThrow("ghia build needs an entry")
    },
    TIMEOUT_MS
  )

  test(
    "builds the entry it is given, over the plugin's",
    async () => {
      await build({ root: appDir, entry: "bare.ts", compile: false })
      const bundle = readFileSync(join(appDir, "dist", "main.js"), "utf8")
      expect(bundle).toContain("WINDOW_AT_LOAD")
      expect(bundle).not.toContain("marker v1")
    },
    TIMEOUT_MS
  )

  test(
    "builds the entry it is given for a config without one",
    async () => {
      await build({ root: appDir, configFile: writeEntrylessConfig(), entry: "bare.ts", compile: false })
      expect(readFileSync(join(appDir, "dist", "main.js"), "utf8")).toContain("WINDOW_AT_LOAD")
    },
    TIMEOUT_MS
  )

  test(
    "rejects when the config has no ghia() plugin",
    async () => {
      writeFileSync(
        join(appDir, "vite.config.plain.ts"),
        `import { defineConfig } from "vite"\nexport default defineConfig({})\n`
      )
      await expect(build({ root: appDir, configFile: join(appDir, "vite.config.plain.ts") })).rejects.toThrow('Add ghia() from "ghia"')
    },
    TIMEOUT_MS
  )
})

describe("dev()", () => {
  test(
    "runs the entry and resolves to a handle that closes",
    async () => {
      const log = spyOn(console, "log")
      const handle = await dev({ root: appDir })
      try {
        expect(log).toHaveBeenCalledWith("RENDERED marker v1")
      } finally {
        log.mockRestore()
        await handle.close()
      }
      // A second close is the same close.
      await handle.close()
    },
    TIMEOUT_MS
  )

  test(
    "runs the entry it is given, resolved against the root, over the plugin's",
    async () => {
      const log = spyOn(console, "log")
      const handle = await dev({ root: appDir, entry: "bare.ts" })
      try {
        expect(log).toHaveBeenCalledWith("WINDOW_AT_LOAD object")
        expect(log).not.toHaveBeenCalledWith("RENDERED marker v1")
      } finally {
        log.mockRestore()
        await handle.close()
      }
    },
    TIMEOUT_MS
  )

  test(
    "runs the entry it is given for a config without one",
    async () => {
      const log = spyOn(console, "log")
      const handle = await dev({ root: appDir, configFile: writeEntrylessConfig(), entry: "bare.ts" })
      try {
        expect(log).toHaveBeenCalledWith("WINDOW_AT_LOAD object")
      } finally {
        log.mockRestore()
        await handle.close()
      }
    },
    TIMEOUT_MS
  )

  test(
    "rejects when the plugin has no entry, and leaves no server open",
    async () => {
      await expect(dev({ root: appDir, configFile: writeEntrylessConfig() })).rejects.toThrow("ghia dev needs an entry")
    },
    TIMEOUT_MS
  )

  test(
    "ignores the VITEST variable a test runner hands down",
    async () => {
      process.env.VITEST = "true"
      const handle = await dev({ root: appDir })
      try {
        expect(process.env.VITEST).toBeUndefined()
      } finally {
        await handle.close()
      }
    },
    TIMEOUT_MS
  )
})
