import { namedError } from "../named-error.js"

const CONSTRUCT = Symbol("Storage")

/** Browsers allow about 5 MiB per origin, counted in UTF-16 code units of keys and values. */
export const STORAGE_QUOTA = 5 * 1024 * 1024

/** Called after each change; the map is the live one, so a caller that defers reads it when it writes. */
export type StoragePersist = (items: ReadonlyMap<string, string>) => void

interface StorageState {
  readonly items: Map<string, string>
  readonly persist: StoragePersist | undefined
  size: number
}

// Both the object and its proxy are keys: a method called on the proxy gets the proxy as `this`.
const states = new WeakMap<object, StorageState>()

function stateOf(storage: unknown): StorageState {
  const state = states.get(storage as object)
  if (state === undefined) throw new TypeError("Illegal invocation")
  return state
}

function requireArguments(method: string, given: number, needed: number): void {
  if (given < needed) {
    throw new TypeError(`Failed to execute '${method}' on 'Storage': ${needed} argument${needed === 1 ? "" : "s"} required, but only ${given} present.`)
  }
}

function sizeOf(key: string, value: string): number {
  return key.length + value.length
}

function changed(state: StorageState, change: () => void): void {
  change()
  state.persist?.(state.items)
}

/** The Web Storage interface: string keys and values, with the items readable as properties of the object. */
export class Storage {
  constructor(token?: symbol, items?: ReadonlyMap<string, string>, persist?: StoragePersist) {
    if (token !== CONSTRUCT) throw new TypeError("Illegal constructor")
    const kept = new Map(items)
    let size = 0
    for (const entry of kept) size += sizeOf(entry[0], entry[1])
    const state: StorageState = { items: kept, persist, size }
    states.set(this, state)
    const proxy = new Proxy(this, storageHandler)
    states.set(proxy, state)
    return proxy
  }

  get length(): number {
    return stateOf(this).items.size
  }

  key(index: number): string | null {
    requireArguments("key", arguments.length, 1)
    // WebIDL `unsigned long`: NaN and Infinity become 0, a negative number wraps to a position past any item.
    const position = Number(index) >>> 0
    let at = 0
    for (const key of stateOf(this).items.keys()) {
      if (at === position) return key
      at += 1
    }
    return null
  }

  getItem(key: string): string | null {
    requireArguments("getItem", arguments.length, 1)
    const value = stateOf(this).items.get(`${key}`)
    return value === undefined ? null : value
  }

  setItem(key: string, value: string): void {
    requireArguments("setItem", arguments.length, 2)
    const state = stateOf(this)
    const name = `${key}`
    const text = `${value}`
    const previous = state.items.get(name)
    if (previous === text) return
    const grown = state.size - (previous === undefined ? 0 : sizeOf(name, previous)) + sizeOf(name, text)
    if (grown > STORAGE_QUOTA) {
      throw namedError("QuotaExceededError", `Failed to execute 'setItem' on 'Storage': Setting the value of '${name}' exceeded the quota.`)
    }
    changed(state, () => {
      state.items.set(name, text)
      state.size = grown
    })
  }

  removeItem(key: string): void {
    requireArguments("removeItem", arguments.length, 1)
    const state = stateOf(this)
    const name = `${key}`
    const previous = state.items.get(name)
    if (previous === undefined) return
    changed(state, () => {
      state.items.delete(name)
      state.size -= sizeOf(name, previous)
    })
  }

  clear(): void {
    const state = stateOf(this)
    if (state.items.size === 0) return
    changed(state, () => {
      state.items.clear()
      state.size = 0
    })
  }
}

/** Whether `name` is an item that reads as a property: a name on the prototype (`getItem`, `length`) shadows an item of that name. */
function isItemProperty(target: Storage, name: string | symbol): name is string {
  return typeof name === "string" && !(name in target) && stateOf(target).items.has(name)
}

const storageHandler: ProxyHandler<Storage> = {
  get(target, name, receiver) {
    if (isItemProperty(target, name)) return stateOf(target).items.get(name)
    return Reflect.get(target, name, receiver)
  },
  // An assignment always makes an item, even under the name of a method, as in a browser.
  set(target, name, value, receiver) {
    if (typeof name === "string") {
      target.setItem(name, value)
      return true
    }
    return Reflect.set(target, name, value, receiver)
  },
  defineProperty(target, name, descriptor) {
    if (typeof name !== "string") return Reflect.defineProperty(target, name, descriptor)
    if (!("value" in descriptor)) return false
    target.setItem(name, descriptor.value)
    return true
  },
  // A name on the prototype shadows an item of that name, so deleting it is an ordinary delete and keeps the item.
  deleteProperty(target, name) {
    if (isItemProperty(target, name)) {
      target.removeItem(name)
      return true
    }
    return Reflect.deleteProperty(target, name)
  },
  has(target, name) {
    return isItemProperty(target, name) || Reflect.has(target, name)
  },
  ownKeys(target) {
    return [...stateOf(target).items.keys(), ...Reflect.ownKeys(target)]
  },
  getOwnPropertyDescriptor(target, name) {
    if (isItemProperty(target, name)) {
      return { value: stateOf(target).items.get(name), writable: true, enumerable: true, configurable: true }
    }
    return Reflect.getOwnPropertyDescriptor(target, name)
  },
}

/** A storage that lives as long as the process. */
export function createMemoryStorage(): Storage {
  return new Storage(CONSTRUCT)
}

/** The path of an app's `localStorage` file on macOS. */
export function localStoragePath(home: string, appId: string): string {
  return `${home}/Library/Application Support/${appId}/Local Storage/localStorage.json`
}

interface NodeFs {
  readFileSync(path: string, encoding: "utf8"): string
  openSync(path: string, flags: "w"): number
  writeFileSync(fd: number, data: string): void
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  rmSync(path: string, options: { force: true }): void
  renameSync(from: string, to: string): void
  mkdirSync(path: string, options: { recursive: true }): void
}

// `process.getBuiltinModule` and not an import keeps `node:fs` out of the web build.
function nodeFs(): NodeFs {
  return process.getBuiltinModule("node:fs") as unknown as NodeFs
}

function readItems(fs: NodeFs, path: string): Map<string, string> {
  let text: string
  try {
    text = fs.readFileSync(path, "utf8")
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return new Map()
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`The localStorage file ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Delete it to start with empty storage.`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The localStorage file ${path} does not hold an object of strings. Delete it to start with empty storage.`)
  }
  const items = new Map<string, string>()
  for (const entry of Object.entries(parsed)) {
    if (typeof entry[1] !== "string") {
      throw new Error(`The localStorage file ${path} holds a value for "${entry[0]}" that is not a string. Delete it to start with empty storage.`)
    }
    items.set(entry[0], entry[1])
  }
  return items
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"))
}

/** Writes of every file storage still waiting for their task; the exit hook and a closed window flush them. */
const pendingWrites = new Set<() => void>()
let exitHookInstalled = false
/** Set once the process is exiting: a change made by an `exit` listener that runs after ours has no later task to wait for. */
let exiting = false

/**
 * Writes what the file storages hold that is not on disk yet. Called when the process exits and when the last window closes,
 * so nothing written before quit is lost.
 */
export function flushStorage(): void {
  for (const flush of [...pendingWrites]) {
    try {
      flush()
    } catch (error) {
      console.error("[ghia] localStorage could not be written", error)
    }
  }
}

const EXIT_SIGNALS = ["SIGINT", "SIGTERM"] as const

function onExit(): void {
  exiting = true
  flushStorage()
}

/**
 * A signal that kills the process runs no `exit` listener, so a queued write would be lost. The handler flushes, removes itself
 * and raises the signal again for its default action. It is installed only for a signal nothing listens for (a listener, such
 * as the one `ghia dev` has for Ctrl-C, decides what the signal does and the process then ends through `exit`), and when one
 * was added since, it flushes and leaves the signal to that listener: raising it would kill the process under it.
 */
function installSignalFlush(signal: (typeof EXIT_SIGNALS)[number]): void {
  if (process.listenerCount(signal) > 0) return
  const handler = () => {
    flushStorage()
    process.off(signal, handler)
    if (process.listenerCount(signal) > 0) return
    if (!(process.pid > 0)) throw new Error(`Cannot raise ${signal} again: process.pid is ${process.pid}`)
    process.kill(process.pid, signal)
  }
  process.on(signal, handler)
}

function writeAtomically(fs: NodeFs, path: string, items: ReadonlyMap<string, string>): void {
  fs.mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    const descriptor = fs.openSync(temporary, "w")
    try {
      fs.writeFileSync(descriptor, JSON.stringify(Object.fromEntries(items)))
      // Without it a power loss after the rename can leave the new name on a file with no content.
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(temporary, path)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * A storage backed by the JSON file at `path`: read once now, and written whole to a temporary file that is renamed over it,
 * so a crash leaves the old content or the new. A change updates memory at once and the write (with its fsync) goes out once
 * for a burst of changes, from a task queued by the first; a browser also persists storage after the call returns. A write
 * that fails is reported to the console and tried again by the next change or the exit flush. During exit a change is written at once.
 */
export function createFileStorage(path: string): Storage {
  const fs = nodeFs()
  const items = readItems(fs, path)
  let queued = false
  let current: ReadonlyMap<string, string> = items
  const flush = () => {
    pendingWrites.delete(flush)
    try {
      writeAtomically(fs, path, current)
    } catch (error) {
      pendingWrites.add(flush)
      throw error
    }
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on("exit", onExit)
    for (const signal of EXIT_SIGNALS) installSignalFlush(signal)
  }
  return new Storage(CONSTRUCT, items, (live) => {
    current = live
    pendingWrites.add(flush)
    if (exiting) {
      flushStorage()
      return
    }
    if (queued) return
    queued = true
    setTimeout(() => {
      queued = false
      if (pendingWrites.has(flush)) flushStorage()
    }, 0)
  })
}

/** Where the plugin leaves the app id for the runtime, before any app module runs. */
export const APP_ID_KEY = Symbol.for("@ghia/native/app-id")

/** Reads the app id the plugin set, or undefined when the app has none (a plain script, a test). */
export function configuredAppId(): string | undefined {
  const id: unknown = Reflect.get(globalThis, APP_ID_KEY)
  if (id === undefined) return undefined
  if (typeof id !== "string" || id === "" || id === "." || id === ".." || /[/\\\0]/.test(id)) {
    throw new Error(`The app id ${JSON.stringify(id)} cannot name a directory: use a name without slashes (the appId option of ghia())`)
  }
  return id
}

let local: Storage | undefined

/** `localStorage`: the file of the app id when there is one, else memory for the process. Made on first use. */
export function getLocalStorage(): Storage {
  if (local !== undefined) return local
  const id = configuredAppId()
  const home = process.getBuiltinModule("node:os") as unknown as { homedir(): string }
  local = id === undefined ? createMemoryStorage() : createFileStorage(localStoragePath(home.homedir(), id))
  return local
}

let sessionItems: Storage | undefined

export function getSessionStorage(): Storage {
  sessionItems ??= createMemoryStorage()
  return sessionItems
}
