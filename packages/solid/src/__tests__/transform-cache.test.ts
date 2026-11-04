import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cachedTransform, transformIdentity } from "../transform-cache.js"

const root = mkdtempSync(join(tmpdir(), "gpuix-solid-transform-cache-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let dir: string
let calls: string[]
let counter = 0

beforeEach(() => {
  dir = join(root, `cache-${counter++}`)
  calls = []
})

async function load(source: string, options: { filename?: string; identity?: string } = {}) {
  return cachedTransform({
    dir,
    filename: options.filename ?? "/app/a.tsx",
    source,
    identity: options.identity ?? "identity-1",
    transform: async (code) => {
      calls.push(code)
      return `compiled(${code})`
    },
  })
}

describe("transform cache", () => {
  it("a miss transforms and writes the entry", async () => {
    expect(await load("one")).toBe("compiled(one)")
    expect(calls).toEqual(["one"])
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it("a second load of the same source hits without transforming", async () => {
    await load("one")
    expect(await load("one")).toBe("compiled(one)")
    expect(calls).toEqual(["one"])
  })

  it("an edited source misses and overwrites the entry of its path", async () => {
    await load("one")
    const [entry] = readdirSync(dir)
    expect(await load("two")).toBe("compiled(two)")
    expect(calls).toEqual(["one", "two"])
    expect(readdirSync(dir)).toEqual([entry!])
    expect(await load("two")).toBe("compiled(two)")
    expect(calls).toEqual(["one", "two"])
  })

  it("each source path has its own entry", async () => {
    await load("one")
    await load("one", { filename: "/app/b.tsx" })
    expect(calls).toEqual(["one", "one"])
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it("a changed identity misses", async () => {
    await load("one")
    await load("one", { identity: "identity-2" })
    expect(calls).toEqual(["one", "one"])
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it("a corrupt entry is a miss and is replaced", async () => {
    await load("one")
    const entry = join(dir, readdirSync(dir)[0]!)
    writeFileSync(entry, "garbage")
    expect(await load("one")).toBe("compiled(one)")
    expect(calls).toEqual(["one", "one"])
    expect(readFileSync(entry, "utf8")).toContain("compiled(one)")
    expect(await load("one")).toBe("compiled(one)")
    expect(calls).toEqual(["one", "one"])
  })

  it("a cache directory that cannot be written still returns the transformed code", async () => {
    const blocked = join(root, "blocked")
    writeFileSync(blocked, "a file where the directory should be")
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const run = () =>
      cachedTransform({
        dir: join(blocked, "nested"),
        filename: "/app/a.tsx",
        source: "one",
        identity: "identity-1",
        transform: async (code) => `compiled(${code})`,
      })
    expect(await run()).toBe("compiled(one)")
    expect(await run()).toBe("compiled(one)")
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe("transform identity", () => {
  it("names the package versions and the presets of the file", async () => {
    const tsx = JSON.parse(await transformIdentity("/app/a.tsx"))
    expect(tsx.slice(0, 4).map((entry: string) => entry.split("@").slice(0, -1).join("@"))).toEqual([
      "@ghia/solid",
      "@babel/core",
      "babel-preset-solid",
      "@babel/preset-typescript",
    ])
    expect(tsx[4]).toEqual({ solid: { generate: "universal", moduleName: "@ghia/solid" }, typescript: true })
    expect(JSON.parse(await transformIdentity("/app/a.jsx"))[4]).toEqual({ solid: tsx[4].solid, typescript: false })
    expect(JSON.parse(await transformIdentity("/app/a.ts"))[4]).toEqual({ solid: null, typescript: true })
  })
})
