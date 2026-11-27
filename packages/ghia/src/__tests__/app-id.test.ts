import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { build, dev, ghia } from "../../dist/index.js"
import type { Plugin } from "vite"

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..")
const SCRATCH_ROOT = join(PACKAGE_ROOT, "fixtures", "tmp")
const TIMEOUT_MS = 60_000

let appDir: string
let homeDir: string

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  appDir = mkdtempSync(join(SCRATCH_ROOT, "app-id-"))
  homeDir = mkdtempSync(join(SCRATCH_ROOT, "home-"))
  cpSync(join(PACKAGE_ROOT, "fixtures", "app"), appDir, { recursive: true })
})

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

// A package.json ends the self-reference of `ghia` that the config of a fixture without one relies on, so the app links the package.
function writeManifest(name: string | undefined): void {
  writeFileSync(join(appDir, "package.json"), JSON.stringify(name === undefined ? { type: "module" } : { name, type: "module" }))
  mkdirSync(join(appDir, "node_modules"), { recursive: true })
  symlinkSync(PACKAGE_ROOT, join(appDir, "node_modules", "ghia"))
}

function writeConfig(options: string): void {
  writeFileSync(
    join(appDir, "vite.config.ts"),
    `import { defineConfig } from "vite"\nimport { ghia } from "ghia"\nexport default defineConfig({ plugins: [ghia({ entry: "app-id.ts"${options} })] })\n`
  )
}

async function runDev(): Promise<string[]> {
  const log = spyOn(console, "log")
  const handle = await dev({ root: appDir, entry: "app-id.ts" })
  try {
    return log.mock.calls.map((call) => String(call[0]))
  } finally {
    log.mockRestore()
    await handle.close()
  }
}

function resolveApi(options: Parameters<typeof ghia>[0], root: string) {
  const plugin = ghia(options)[0] as Plugin
  const hook = plugin.configResolved
  if (typeof hook !== "function") throw new Error("configResolved is a function hook")
  hook.call({} as never, { root, inlineConfig: {}, environments: {} } as never)
  return (plugin.api as { appId: string | undefined }).appId
}

describe("the appId option", () => {
  test("defaults to the name of the package.json in the root", () => {
    writeManifest("my-app")
    expect(resolveApi({}, appDir)).toBe("my-app")
  })

  test("turns a scoped package name into one directory name", () => {
    writeManifest("@acme/demo")
    expect(resolveApi({}, appDir)).toBe("acme-demo")
  })

  test("is the option when given, over the package name", () => {
    writeManifest("my-app")
    expect(resolveApi({ appId: "Custom App" }, appDir)).toBe("Custom App")
  })

  test("is undefined without a package.json or a name", () => {
    expect(resolveApi({}, appDir)).toBeUndefined()
    writeManifest(undefined)
    expect(resolveApi({}, appDir)).toBeUndefined()
  })

  test("must be a directory name", () => {
    expect(() => resolveApi({ appId: "a/b" }, appDir)).toThrow("cannot name a directory")
    expect(() => resolveApi({ appId: ".." }, appDir)).toThrow("cannot name a directory")
    expect(() => resolveApi({ appId: "" }, appDir)).toThrow("cannot name a directory")
  })
})

describe("the app id the runtime gets", () => {
  test(
    "reaches the entry and the modules it imports under ghia dev, before they run",
    async () => {
      writeManifest("@acme/demo")
      const lines = await runDev()
      expect(lines).toContain("APP_ID_AT_IMPORT acme-demo")
      expect(lines).toContain("APP_ID acme-demo")
    },
    TIMEOUT_MS
  )

  test(
    "is the option's value, and localStorage of a built app is the file of that id",
    async () => {
      writeManifest("ignored-name")
      writeConfig(', appId: "built-app"')
      await build({ root: appDir, compile: false })
      const bundle = readFileSync(join(appDir, "dist", "main.js"), "utf8")
      expect(bundle).toContain("built-app")
      const run = Bun.spawnSync(["bun", join(appDir, "dist", "main.js")], { env: { ...process.env, HOME: homeDir, APP_ID_FIXTURE_WRITE: "1" } })
      expect(run.stdout.toString()).toContain("APP_ID_AT_IMPORT built-app")
      expect(run.exitCode).toBe(0)
      const file = join(homeDir, "Library", "Application Support", "built-app", "Local Storage", "localStorage.json")
      expect(existsSync(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ greeting: "hello" })
    },
    TIMEOUT_MS
  )
})
