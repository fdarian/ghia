import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../dom-globals.js"
import {
  APP_ID_KEY,
  createFileStorage,
  createMemoryStorage,
  localStoragePath,
  STORAGE_QUOTA,
  Storage,
} from "../shell/storage.js"

describe("Storage", () => {
  it("is a Storage with the Web Storage methods", () => {
    const storage = createMemoryStorage()
    expect(storage).toBeInstanceOf(Storage)
    expect(storage.length).toBe(0)
    expect(storage.getItem("a")).toBeNull()
    storage.setItem("a", "1")
    storage.setItem("b", 2 as unknown as string)
    expect(storage.getItem("b")).toBe("2")
    expect(storage.length).toBe(2)
    expect([storage.key(0), storage.key(1), storage.key(2), storage.key(-1)]).toEqual(["a", "b", null, null])
    storage.removeItem("a")
    storage.removeItem("missing")
    expect(storage.length).toBe(1)
    storage.clear()
    expect(storage.length).toBe(0)
    expect(() => new (Storage as unknown as new () => object)()).toThrow(TypeError)
    expect(() => (storage.setItem as (key: string) => void)("only-key")).toThrow(TypeError)
    expect(() => storage.setItem(Symbol("s") as unknown as string, "x")).toThrow(TypeError)
  })

  it("reads and writes items as properties", () => {
    const storage = createMemoryStorage() as Storage & Record<string, unknown>
    storage.foo = 12
    expect(storage.getItem("foo")).toBe("12")
    expect(storage.foo).toBe("12")
    expect("foo" in storage).toBe(true)
    expect(Object.keys(storage)).toEqual(["foo"])
    expect(JSON.stringify(storage)).toBe('{"foo":"12"}')
    delete storage.foo
    expect(storage.getItem("foo")).toBeNull()
    expect(storage.foo).toBeUndefined()
    // A name on the prototype reads as the member, and an assignment still makes an item.
    storage.getItem = "x"
    expect(typeof storage.getItem).toBe("function")
    expect(storage.length).toBe(1)
    storage.clear()
    expect(storage.length).toBe(0)
  })

  it("throws QuotaExceededError past 5 MiB of UTF-16 code units and keeps what it had", () => {
    const storage = createMemoryStorage()
    storage.setItem("big", "x".repeat(STORAGE_QUOTA - 3))
    expect(() => storage.setItem("big2", "y")).toThrow(expect.objectContaining({ name: "QuotaExceededError" }))
    expect(storage.getItem("big2")).toBeNull()
    storage.setItem("big", "z")
    storage.setItem("big2", "y".repeat(100))
    expect(storage.length).toBe(2)
  })

  it("sessionStorage and localStorage are separate storages, in memory without an app id", () => {
    expect(sessionStorage).toBeInstanceOf(Storage)
    expect(localStorage).toBeInstanceOf(Storage)
    expect(sessionStorage).not.toBe(localStorage)
    sessionStorage.setItem("k", "v")
    expect(localStorage.getItem("k")).toBeNull()
    sessionStorage.clear()
  })
})

describe("a file-backed Storage", () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ghia-storage-"))
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it("persists every change and loads it again", () => {
    const path = localStoragePath(directory, "my-app")
    expect(path).toBe(join(directory, "Library", "Application Support", "my-app", "Local Storage", "localStorage.json"))
    const first = createFileStorage(path)
    first.setItem("theme", "dark")
    first.setItem("a/b", "c")
    first.setItem("gone", "x")
    first.removeItem("gone")
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "dark", "a/b": "c" })
    const second = createFileStorage(path)
    expect(second.getItem("theme")).toBe("dark")
    expect(second.length).toBe(2)
    second.clear()
    expect(createFileStorage(path).length).toBe(0)
    expect(readdirSync(join(path, ".."))).toEqual(["localStorage.json"])
  })

  it("starts empty without a file and rejects one that is not a JSON object of strings", () => {
    const path = join(directory, "x", "localStorage.json")
    expect(createFileStorage(path).length).toBe(0)
    expect(existsSync(path)).toBe(false)
    mkdirSync(join(directory, "x"), { recursive: true })
    writeFileSync(path, "{nope")
    expect(() => createFileStorage(path)).toThrow(/not valid JSON/)
    writeFileSync(path, '{"a":1}')
    expect(() => createFileStorage(path)).toThrow(/not a string/)
    writeFileSync(path, "[]")
    expect(() => createFileStorage(path)).toThrow(/object of strings/)
  })

  it("undoes a change that could not be written", () => {
    const path = join(directory, "dir", "localStorage.json")
    const storage = createFileStorage(path)
    storage.setItem("kept", "1")
    rmSync(join(directory, "dir"), { recursive: true })
    writeFileSync(join(directory, "dir"), "a file where the directory should be")
    expect(() => storage.setItem("lost", "2")).toThrow()
    expect(storage.getItem("lost")).toBeNull()
    expect(storage.getItem("kept")).toBe("1")
  })
})

describe("localStorage of an app id", () => {
  const home = process.env.HOME
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ghia-home-"))
    process.env.HOME = directory
    vi.resetModules()
  })
  afterEach(() => {
    process.env.HOME = home
    Reflect.deleteProperty(globalThis, APP_ID_KEY)
    rmSync(directory, { recursive: true, force: true })
  })

  // Bun's os.homedir() does not follow a write to process.env.HOME; the built app's path under Bun is covered by packages/ghia's app-id test.
  it.skipIf(typeof Bun !== "undefined")("lives in Application Support and survives loading the module again", async () => {
    Reflect.set(globalThis, APP_ID_KEY, "demo-app")
    const first = await import("../shell/storage.js")
    first.getLocalStorage().setItem("token", "abc")
    const file = join(directory, "Library", "Application Support", "demo-app", "Local Storage", "localStorage.json")
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: "abc" })
    vi.resetModules()
    const reloaded = await import("../shell/storage.js")
    expect(reloaded.getLocalStorage()).not.toBe(first.getLocalStorage())
    expect(reloaded.getLocalStorage().getItem("token")).toBe("abc")
  })

  it("refuses an app id that is not a directory name", async () => {
    Reflect.set(globalThis, APP_ID_KEY, "../escape")
    const storage = await import("../shell/storage.js")
    expect(() => storage.getLocalStorage()).toThrow(/cannot name a directory/)
  })
})
