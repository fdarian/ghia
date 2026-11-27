import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../dom-globals.js"
import {
  APP_ID_KEY,
  createFileStorage,
  createMemoryStorage,
  flushStorage,
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

  it("key() converts its argument like a WebIDL unsigned long", () => {
    const storage = createMemoryStorage()
    storage.setItem("a", "1")
    storage.setItem("b", "2")
    expect([storage.key(Infinity), storage.key(NaN), storage.key(1.9), storage.key("1" as unknown as number)]).toEqual(["a", "a", "b", "b"])
    expect([storage.key(-1), storage.key(2 ** 32 + 1), storage.key(-Infinity)]).toEqual([null, "b", "a"])
  })

  it("delete on the name of a method is an ordinary delete and leaves an item of that name", () => {
    const storage = createMemoryStorage() as Storage & Record<string, unknown>
    storage.setItem("getItem", "x")
    storage.setItem("other", "y")
    expect(delete storage.getItem).toBe(true)
    expect(storage.length).toBe(2)
    expect(typeof storage.getItem).toBe("function")
    expect(delete storage.other).toBe(true)
    expect(storage.length).toBe(1)
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

  const afterTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it("persists every change after the task and loads it again", async () => {
    const path = localStoragePath(directory, "my-app")
    expect(path).toBe(join(directory, "Library", "Application Support", "my-app", "Local Storage", "localStorage.json"))
    const first = createFileStorage(path)
    first.setItem("theme", "dark")
    first.setItem("a/b", "c")
    first.setItem("gone", "x")
    first.removeItem("gone")
    expect(existsSync(path)).toBe(false)
    await afterTask()
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "dark", "a/b": "c" })
    const second = createFileStorage(path)
    expect(second.getItem("theme")).toBe("dark")
    expect(second.length).toBe(2)
    second.clear()
    await afterTask()
    expect(createFileStorage(path).length).toBe(0)
    expect(readdirSync(join(path, ".."))).toEqual(["localStorage.json"])
  })

  it("writes once for any number of changes in one task, and again for a later one", async () => {
    const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs")
    const rename = vi.spyOn(fs, "renameSync")
    const fsync = vi.spyOn(fs, "fsyncSync")
    try {
      const storage = createFileStorage(join(directory, "burst", "localStorage.json"))
      for (let at = 0; at < 100; at += 1) storage.setItem(`k${at}`, `v${at}`)
      expect(storage.length).toBe(100)
      expect(storage.getItem("k99")).toBe("v99")
      expect(rename).toHaveBeenCalledTimes(0)
      await afterTask()
      expect(rename).toHaveBeenCalledTimes(1)
      expect(fsync).toHaveBeenCalledTimes(1)
      await afterTask()
      expect(rename).toHaveBeenCalledTimes(1)
      storage.setItem("later", "1")
      await afterTask()
      expect(rename).toHaveBeenCalledTimes(2)
      expect(Object.keys(JSON.parse(readFileSync(join(directory, "burst", "localStorage.json"), "utf8")))).toHaveLength(101)
    } finally {
      rename.mockRestore()
      fsync.mockRestore()
    }
  })

  it("flushStorage writes what is waiting, before the task", () => {
    const path = join(directory, "exit", "localStorage.json")
    const storage = createFileStorage(path)
    storage.setItem("unsaved", "1")
    expect(existsSync(path)).toBe(false)
    flushStorage()
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ unsaved: "1" })
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

  it("flushes the temporary file to disk before it renames it over the file", async () => {
    const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs")
    const order: string[] = []
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => void order.push("fsync"))
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => void order.push("rename"))
    try {
      createFileStorage(join(directory, "f", "localStorage.json")).setItem("k", "v")
      await afterTask()
    } finally {
      fsync.mockRestore()
      rename.mockRestore()
    }
    expect(order).toEqual(["fsync", "rename"])
  })

  it("removes the temporary file when the write fails, reports it, and writes again on the next change", async () => {
    const path = join(directory, "dir", "localStorage.json")
    const storage = createFileStorage(path)
    storage.setItem("kept", "1")
    await afterTask()
    // A directory where the file was: the rename of the temporary file over it fails.
    rmSync(path)
    mkdirSync(path)
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      storage.setItem("lost", "2")
      await afterTask()
      expect(report).toHaveBeenCalledTimes(1)
      expect(readdirSync(join(directory, "dir"))).toEqual(["localStorage.json"])
      expect(storage.getItem("lost")).toBe("2")
      rmSync(path, { recursive: true })
      storage.setItem("more", "3")
      await afterTask()
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ kept: "1", lost: "2", more: "3" })
    } finally {
      report.mockRestore()
    }
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
    first.flushStorage()
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

describe("a file-backed Storage in a process that ends", () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ghia-storage-end-"))
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  const storageModule = fileURLToPath(new URL("../shell/storage.ts", import.meta.url))

  const CHILD_DEADLINE_MS = 10_000

  interface Ended {
    code: number | null
    signal: NodeJS.Signals | null
    output: string
  }

  /** Runs `body` in a Bun child with `createFileStorage`, `path` and a `ready()` that prints and, when `signal` is given, waits for the parent to send it. */
  function runChild(body: string, signal?: NodeJS.Signals): Promise<Ended> {
    const script = join(directory, "child.ts")
    writeFileSync(
      script,
      `import { createFileStorage } from ${JSON.stringify(storageModule)}
const path = process.argv[2]!
const ready = () => console.log("ready")
${body}
`,
    )
    const path = join(directory, "data", "localStorage.json")
    return new Promise((resolve, reject) => {
      const child = spawn("bun", [script, path], { stdio: ["ignore", "pipe", "pipe"] })
      // A re-raise that does not happen would leave the child running and the test waiting.
      const deadline = setTimeout(() => child.kill("SIGKILL"), CHILD_DEADLINE_MS)
      let output = ""
      let sent = false
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString()
        if (signal !== undefined && !sent && output.includes("ready")) {
          sent = true
          child.kill(signal)
        }
      })
      child.stderr.on("data", (chunk: Buffer) => void (output += chunk.toString()))
      child.on("error", reject)
      child.on("close", (code, ended) => {
        clearTimeout(deadline)
        resolve({ code, signal: ended, output })
      })
    })
  }

  const written = () => JSON.parse(readFileSync(join(directory, "data", "localStorage.json"), "utf8"))

  // Stops the write task, as a signal that arrives before it does, and keeps the process alive for the signal.
  const NO_TASK = `const keepAlive = setInterval(() => {}, 1000)
globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout`

  it("writes a change made by an exit listener that was registered after the storage was", async () => {
    const ended = await runChild(`const storage = createFileStorage(path)
process.on("exit", () => storage.setItem("late", "1"))`)
    expect(ended.code, ended.output).toBe(0)
    expect(written()).toEqual({ late: "1" })
  })

  it("writes a queued change on SIGTERM and then dies of the signal", async () => {
    const ended = await runChild(
      `${NO_TASK}
createFileStorage(path).setItem("queued", "1")
ready()`,
      "SIGTERM",
    )
    expect(ended.signal, ended.output).toBe("SIGTERM")
    expect(written()).toEqual({ queued: "1" })
  })

  it("writes a queued change on SIGINT and then dies of the signal", async () => {
    const ended = await runChild(
      `${NO_TASK}
createFileStorage(path).setItem("queued", "1")
ready()`,
      "SIGINT",
    )
    expect(ended.signal, ended.output).toBe("SIGINT")
    expect(written()).toEqual({ queued: "1" })
  })

  it("leaves a signal to a listener added after the storage: it flushes and does not raise the signal again", async () => {
    const ended = await runChild(
      `${NO_TASK}
createFileStorage(path).setItem("queued", "1")
process.on("SIGTERM", () => {
  console.log("handled")
  clearInterval(keepAlive)
})
ready()`,
      "SIGTERM",
    )
    expect(ended.signal, ended.output).toBeNull()
    expect(ended.code, ended.output).toBe(0)
    expect(ended.output).toContain("handled")
    expect(written()).toEqual({ queued: "1" })
  })

  it("keeps its handler beside a listener that is already there: it flushes and does not raise the signal again", async () => {
    const ended = await runChild(
      `${NO_TASK}
process.on("SIGINT", () => {
  console.log("handled")
  process.exit(3)
})
createFileStorage(path).setItem("queued", "1")
console.log(process.listenerCount("SIGINT"))
ready()`,
      "SIGINT",
    )
    expect(ended.signal, ended.output).toBeNull()
    expect(ended.code, ended.output).toBe(3)
    expect(ended.output).toContain("handled")
    expect(ended.output).toContain("2")
    expect(written()).toEqual({ queued: "1" })
  })

  it("leaves a signal to a once listener added after the storage, which is removed before it runs", async () => {
    const ended = await runChild(
      `${NO_TASK}
createFileStorage(path).setItem("queued", "1")
process.once("SIGTERM", () => {
  console.log("handled")
  clearInterval(keepAlive)
})
ready()`,
      "SIGTERM",
    )
    expect(ended.signal, ended.output).toBeNull()
    expect(ended.code, ended.output).toBe(0)
    expect(ended.output).toContain("handled")
    expect(written()).toEqual({ queued: "1" })
  })

  it("leaves a signal to a once listener that was there before the storage", async () => {
    const ended = await runChild(
      `${NO_TASK}
process.once("SIGINT", () => {
  console.log("handled")
  clearInterval(keepAlive)
})
createFileStorage(path).setItem("queued", "1")
ready()`,
      "SIGINT",
    )
    expect(ended.signal, ended.output).toBeNull()
    expect(ended.code, ended.output).toBe(0)
    expect(ended.output).toContain("handled")
    expect(written()).toEqual({ queued: "1" })
  })
})
