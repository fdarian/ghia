/**
 * `DataTransfer`, `DataTransferItemList` and `DataTransferItem` (HTML, "The DataTransfer
 * interface"): the data of a drag and of a clipboard event, and a constructible store an app
 * fills itself (`new DataTransfer()`, read/write). The runtime switches the mode of the one it
 * hands a handler through `dataTransferState`, which `dom-globals` does not install.
 */

import { namedError } from "../named-error.js"

/**
 * What a handler may do with a data transfer, as the DOM's drag data store modes: `readwrite`
 * where `setData` works, `readonly` where only `getData` does, and `protected` where `getData`
 * is empty and `setData` does nothing, but `types` is still listed.
 */
export type DataTransferMode = "readwrite" | "readonly" | "protected"

export type DropEffect = "none" | "copy" | "link" | "move"

export type EffectAllowed =
  | "none"
  | "copy"
  | "copyLink"
  | "copyMove"
  | "link"
  | "linkMove"
  | "move"
  | "all"
  | "uninitialized"

/** What a `File` is to a data transfer: a drag of files from the OS gives objects with more (a path), not `File`s. */
export interface DataTransferFile {
  readonly name: string
  readonly type: string
}

export type FileListLike<File extends DataTransferFile = DataTransferFile> = readonly File[] & {
  item(index: number): File | null
}

const DROP_EFFECTS: ReadonlySet<string> = new Set(["none", "copy", "link", "move"])

const EFFECTS_ALLOWED: ReadonlySet<string> = new Set([
  "none",
  "copy",
  "copyLink",
  "copyMove",
  "link",
  "linkMove",
  "move",
  "all",
  "uninitialized",
])

type StringEntry = { readonly kind: "string"; readonly type: string; readonly data: string }
type FileEntry = { readonly kind: "file"; readonly type: string; readonly file: DataTransferFile }
type Entry = StringEntry | FileEntry

/** The drag data store: the one thing the three classes share. Not part of the DOM. */
export class DataTransferState {
  mode: DataTransferMode = "readwrite"
  effectAllowed: EffectAllowed = "none"
  dropEffect: DropEffect = "none"
  readonly entries: Entry[] = []
  readonly itemOf = new WeakMap<Entry, DataTransferItem>()
  /**
   * What the Clipboard API's "fire a clipboard event" tracks while a handler may write: `clearData()` or
   * `items.clear()` was called, and for which types (none: all of them). A write of a type takes it
   * off again.
   */
  clearWasCalled = false
  typesToClear: string[] = []
  private typesCache: readonly string[] | undefined
  private filesCache: FileListLike | undefined
  /** Set by the item list, which keeps its index properties in step. */
  onChange: () => void = () => {}

  changed(): void {
    this.typesCache = undefined
    this.filesCache = undefined
    this.onChange()
  }

  types(): readonly string[] {
    if (this.typesCache === undefined) {
      const types: string[] = []
      for (const entry of this.entries) if (entry.kind === "string") types.push(entry.type)
      if (this.entries.some((entry) => entry.kind === "file")) types.push("Files")
      this.typesCache = Object.freeze(types)
    }
    return this.typesCache
  }

  files(): FileListLike {
    if (this.filesCache === undefined) {
      const files: DataTransferFile[] = []
      for (const entry of this.entries) if (entry.kind === "file") files.push(entry.file)
      Object.defineProperty(files, "item", {
        value: (index: number) => files[index] ?? null,
      })
      this.filesCache = Object.freeze(files) as FileListLike
    }
    return this.filesCache
  }

  find(type: string): StringEntry | undefined {
    for (const entry of this.entries) if (entry.kind === "string" && entry.type === type) return entry
    return undefined
  }

  remove(entry: Entry): void {
    this.entries.splice(this.entries.indexOf(entry), 1)
    this.changed()
  }

  noteClear(type?: string): void {
    this.clearWasCalled = true
    if (type !== undefined) this.typesToClear.push(type)
  }

  private noteWrite(type: string): void {
    if (!this.clearWasCalled) return
    if (this.typesToClear.length === 0) {
      this.clearWasCalled = false
      return
    }
    const index = this.typesToClear.indexOf(type)
    if (index === -1) return
    this.typesToClear.splice(index, 1)
    if (this.typesToClear.length === 0) this.clearWasCalled = false
  }

  add(entry: Entry): DataTransferItem {
    if (this.mode === "readwrite") this.noteWrite(entry.type)
    this.entries.push(entry)
    this.changed()
    return itemFor(this, entry)
  }
}

const states = new WeakMap<DataTransfer, DataTransferState>()
const CONSTRUCT = Symbol("DataTransfer internals")

function itemFor(state: DataTransferState, entry: Entry): DataTransferItem {
  let item = state.itemOf.get(entry)
  if (item === undefined) {
    item = new DataTransferItem(CONSTRUCT, state, entry)
    state.itemOf.set(entry, item)
  }
  return item
}

/** `"text"` and `"url"` are the legacy names of two MIME types, and formats ignore case. */
function normalizeFormat(format: string): string {
  const lower = String(format).toLowerCase()
  if (lower === "text") return "text/plain"
  if (lower === "url") return "text/uri-list"
  return lower
}

/** The first line of a `text/uri-list` that is not a comment. */
function firstUrl(list: string): string {
  for (const line of list.split(/\r\n|\r|\n/)) {
    if (line !== "" && !line.startsWith("#")) return line
  }
  return ""
}

export class DataTransferItem {
  readonly #state: DataTransferState
  readonly #entry: Entry

  /** @internal */
  constructor(token: symbol, state: DataTransferState, entry: Entry) {
    if (token !== CONSTRUCT) throw new TypeError("Illegal constructor")
    this.#state = state
    this.#entry = entry
  }

  get kind(): "string" | "file" {
    return this.#entry.kind
  }

  get type(): string {
    return this.#entry.type
  }

  getAsString(callback: ((data: string) => void) | null): void {
    if (callback === null || callback === undefined) return
    const entry = this.#entry
    if (this.#state.mode === "protected" || entry.kind !== "string") return
    if (!this.#state.entries.includes(entry)) return
    queueMicrotask(() => callback(entry.data))
  }

  getAsFile(): DataTransferFile | null {
    const entry = this.#entry
    if (this.#state.mode === "protected" || entry.kind !== "file") return null
    if (!this.#state.entries.includes(entry)) return null
    return entry.file
  }
}

export class DataTransferItemList {
  readonly #state: DataTransferState
  #indexed = 0;
  [index: number]: DataTransferItem

  /** @internal */
  constructor(token: symbol, state: DataTransferState) {
    if (token !== CONSTRUCT) throw new TypeError("Illegal constructor")
    this.#state = state
    state.onChange = () => this.#sync()
  }

  get length(): number {
    return this.#state.entries.length
  }

  add(data: string, type: string): DataTransferItem | null
  add(file: DataTransferFile): DataTransferItem | null
  add(data: string | DataTransferFile, type?: string): DataTransferItem | null {
    if (this.#state.mode !== "readwrite") return null
    if (typeof data !== "string") {
      return this.#state.add({ kind: "file", type: String(data.type).toLowerCase(), file: data })
    }
    const lower = String(type).toLowerCase()
    if (this.#state.find(lower) !== undefined) {
      throw namedError("NotSupportedError", `An item of type "${lower}" already exists.`)
    }
    return this.#state.add({ kind: "string", type: lower, data })
  }

  remove(index: number): void {
    if (this.#state.mode !== "readwrite") {
      throw namedError("InvalidStateError", "The data transfer is not writable.")
    }
    const entry = this.#state.entries[index]
    if (entry !== undefined) this.#state.remove(entry)
  }

  clear(): void {
    if (this.#state.mode !== "readwrite") return
    this.#state.noteClear()
    if (this.#state.entries.length === 0) return
    this.#state.entries.length = 0
    this.#state.changed()
  }

  *[Symbol.iterator](): IterableIterator<DataTransferItem> {
    for (const entry of [...this.#state.entries]) yield itemFor(this.#state, entry)
  }

  #sync(): void {
    const entries = this.#state.entries
    for (let index = 0; index < entries.length; index++) {
      Object.defineProperty(this, index, {
        value: itemFor(this.#state, entries[index]!),
        enumerable: true,
        configurable: true,
      })
    }
    for (let index = entries.length; index < this.#indexed; index++) delete this[index]
    this.#indexed = entries.length
  }
}

export class DataTransfer {
  readonly #state = new DataTransferState()
  readonly #items: DataTransferItemList

  constructor() {
    this.#items = new DataTransferItemList(CONSTRUCT, this.#state)
    states.set(this, this.#state)
  }

  get dropEffect(): DropEffect {
    return this.#state.dropEffect
  }

  set dropEffect(value: DropEffect) {
    if (DROP_EFFECTS.has(value)) this.#state.dropEffect = value
  }

  get effectAllowed(): EffectAllowed {
    return this.#state.effectAllowed
  }

  set effectAllowed(value: EffectAllowed) {
    if (this.#state.mode === "readwrite" && EFFECTS_ALLOWED.has(value)) this.#state.effectAllowed = value
  }

  get items(): DataTransferItemList {
    return this.#items
  }

  get types(): readonly string[] {
    return this.#state.types()
  }

  get files(): FileListLike {
    return this.#state.files()
  }

  getData(format: string): string {
    if (this.#state.mode === "protected") return ""
    const entry = this.#state.find(normalizeFormat(format))
    if (entry === undefined) return ""
    return String(format).toLowerCase() === "url" ? firstUrl(entry.data) : entry.data
  }

  setData(format: string, data: string): void {
    if (this.#state.mode !== "readwrite") return
    const type = normalizeFormat(format)
    const existing = this.#state.find(type)
    if (existing !== undefined) this.#state.remove(existing)
    this.#state.add({ kind: "string", type, data: String(data) })
  }

  clearData(format?: string): void {
    if (this.#state.mode !== "readwrite") return
    this.#state.noteClear(format === undefined ? undefined : normalizeFormat(format))
    // Files are kept: only `items.clear()` drops them.
    if (format === undefined) {
      for (const entry of this.#state.entries.filter((candidate) => candidate.kind === "string")) {
        this.#state.remove(entry)
      }
      return
    }
    const entry = this.#state.find(normalizeFormat(format))
    if (entry !== undefined) this.#state.remove(entry)
  }

  /** Accepted and ignored: there is no drag image. */
  setDragImage(_element: unknown, _x: number, _y: number): void {}
}

/** What the runtime does to a data transfer that a handler may not: its mode, and files from the OS. */
export interface DataTransferControl {
  mode: DataTransferMode
  /** Sets `effectAllowed` whatever the mode, which the setter does not. */
  effectAllowed: EffectAllowed
  /** A handler cleared the store while it could write, and wrote nothing of a cleared type since (see `DataTransferState`). */
  readonly clearWasCalled: boolean
  /** The types it cleared, empty when it cleared them all. */
  readonly typesToClear: readonly string[]
  addFile(file: DataTransferFile): void
}

export function dataTransferControl(dataTransfer: DataTransfer): DataTransferControl {
  const state = states.get(dataTransfer)
  if (state === undefined) throw new TypeError("Not a DataTransfer made by this runtime.")
  return {
    get mode() {
      return state.mode
    },
    set mode(value) {
      state.mode = value
    },
    get effectAllowed() {
      return state.effectAllowed
    },
    set effectAllowed(value) {
      state.effectAllowed = value
    },
    get clearWasCalled() {
      return state.clearWasCalled
    },
    get typesToClear() {
      return state.typesToClear
    },
    addFile(file) {
      state.add({ kind: "file", type: file.type, file })
    },
  }
}
