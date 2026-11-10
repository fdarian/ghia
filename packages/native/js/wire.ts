/**
 * Writer for the binary mutation batch. Rust reads it in `src/batch/wire.rs`; the
 * format is specified in `docs/reference.md` ("Wire format"). Opcodes and value
 * tags are the same numbers in both files, so change them together.
 *
 * Growable buffers are reused from batch to batch, so writing an op allocates
 * nothing but what a string or a custom prop value needs.
 */

export const WIRE_FORMAT_VERSION = 1

export const WIRE_OPCODE = {
  createElement: 1,
  destroyElement: 2,
  detachChild: 3,
  appendChild: 4,
  insertBefore: 5,
  setStyle: 6,
  setText: 7,
  setEventListener: 8,
  setRoot: 9,
  setKeyboardFocusDim: 10,
  setUniversalStyle: 11,
  setCustomProp: 12,
  setAttribute: 13,
  setStyleSheet: 14,
  setAdoptedStyleSheets: 15,
} as const

export const WIRE_VALUE_TAG = {
  null: 0,
  false: 1,
  true: 2,
  uint: 3,
  negativeInt: 4,
  float: 5,
  string: 6,
  json: 7,
} as const

/** What a `setCustomProp` carries: anything JSON can hold. */
export type WireValue = number | string | boolean | object | null | undefined

const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER
const INITIAL_CAPACITY = 16 * 1024
const INITIAL_OPS = 512
/** An offsets table grown past this by one huge batch is let go with its batch. */
const RETAINED_OPS = 64 * 1024
/** A buffer grown past this by one huge batch is let go at `finish`, not kept for the life of the app. */
const RETAINED_CAPACITY = 1024 * 1024
/**
 * Bytes reserved ahead of the first op: the version byte and the op count as a
 * varint padded to five bytes (the count is not known until `finish`).
 */
const HEADER_BYTES = 6
const COUNT_WIDTH = 5
/** One id is a varint of at most eight bytes, since it is at most 2^53 - 1. */
const MAX_ID_BYTES = 8
/**
 * Strings up to this many UTF-16 units are copied by a loop that stops at the
 * first non-ASCII unit. `encodeInto` needs a `subarray` of the buffer for each
 * string, which costs more than copying a type name or an event name.
 */
const SHORT_STRING = 32

/**
 * A finished batch, until it is released. It remembers where each op starts, so a
 * rejected op can be cut out of it by byte range and the rest sent again.
 */
export class WireBatch {
  /** The writer swaps these three with its own at `finish`, `release` and `recover`. */
  bytes: Uint8Array
  view: DataView
  /** Start offset of op `index`, in `bytes`. */
  offsets: Uint32Array
  /** Ops the batch holds. */
  count = 0
  /** Bytes the batch holds, header included. */
  length = HEADER_BYTES

  constructor() {
    this.bytes = new Uint8Array(INITIAL_CAPACITY)
    this.view = new DataView(this.bytes.buffer)
    this.offsets = new Uint32Array(INITIAL_OPS)
  }

  /** What native is handed: a view of the batch, valid until it is released. */
  get wire(): Uint8Array {
    return this.bytes.subarray(0, this.length)
  }

  opcodeAt(index: number): number {
    return this.bytes[this.offsets[index]]
  }

  /** Cuts op `index` out of the batch. Later ops keep their order and move down, so native numbers them by their new position. */
  dropOp(index: number): void {
    const start = this.offsets[index]
    const end = index + 1 < this.count ? this.offsets[index + 1] : this.length
    const removed = end - start
    this.bytes.copyWithin(start, end, this.length)
    this.offsets.copyWithin(index, index + 1, this.count)
    this.count--
    for (let next = index; next < this.count; next++) this.offsets[next] -= removed
    this.length -= removed
    writeHeader(this.bytes, this.count)
  }
}

/**
 * Builds one batch at a time. `finish()` returns it and starts the next one in
 * another buffer, so what is written while a batch is being applied (an
 * `autoFocus` handler that enqueues) cannot overwrite it.
 *
 * A finished batch is the caller's until `release(batch)` (applied) or
 * `recover(batch)` (not applied: its ops go back in front of what was written
 * since). Buffers are pooled, so a batch applied inside another's apply gets its
 * own and nothing is allocated in the steady state.
 *
 * A method that throws (an id that is not a non-negative safe integer) leaves
 * the batch as it was before the call.
 */
export class WireWriter {
  private bytes: Uint8Array = new Uint8Array(INITIAL_CAPACITY)
  private view: DataView = new DataView(this.bytes.buffer)
  private offsets: Uint32Array = new Uint32Array(INITIAL_OPS)
  private position = HEADER_BYTES
  private opStart = HEADER_BYTES
  private count = 0
  private readonly free: WireBatch[] = []
  /** Absent where there is no `TextEncoder` (Hermes): UTF-8 is then written by hand. */
  private readonly encoder = typeof TextEncoder === "undefined" ? undefined : new TextEncoder()

  /** Ops written since the last `finish` or `clear`. */
  get opCount(): number {
    return this.count
  }

  /** Bytes of ops written since the last `finish` or `clear`. */
  get byteLength(): number {
    return this.position - HEADER_BYTES
  }

  createElement(id: number, elementType: string): void {
    this.begin(WIRE_OPCODE.createElement, MAX_ID_BYTES + stringBound(elementType))
    this.id(id)
    this.string(elementType)
  }

  destroyElement(id: number): void {
    this.begin(WIRE_OPCODE.destroyElement, MAX_ID_BYTES)
    this.id(id)
  }

  detachChild(id: number): void {
    this.begin(WIRE_OPCODE.detachChild, MAX_ID_BYTES)
    this.id(id)
  }

  appendChild(parentId: number, childId: number): void {
    this.begin(WIRE_OPCODE.appendChild, 2 * MAX_ID_BYTES)
    this.id(parentId)
    this.id(childId)
  }

  insertBefore(parentId: number, childId: number, beforeId: number): void {
    this.begin(WIRE_OPCODE.insertBefore, 3 * MAX_ID_BYTES)
    this.id(parentId)
    this.id(childId)
    this.id(beforeId)
  }

  /** `styleJson` is the exact text native interns by, `JSON.stringify` of the style. */
  setStyle(id: number, styleJson: string): void {
    this.begin(WIRE_OPCODE.setStyle, MAX_ID_BYTES + stringBound(styleJson))
    this.id(id)
    this.string(styleJson)
  }

  setText(id: number, content: string): void {
    this.begin(WIRE_OPCODE.setText, MAX_ID_BYTES + stringBound(content))
    this.id(id)
    this.string(content)
  }

  setEventListener(id: number, eventType: string, hasHandler: boolean): void {
    this.begin(WIRE_OPCODE.setEventListener, MAX_ID_BYTES + stringBound(eventType) + 1)
    this.id(id)
    this.string(eventType)
    this.bytes[this.position++] = hasHandler ? 1 : 0
  }

  setRoot(id: number): void {
    this.begin(WIRE_OPCODE.setRoot, MAX_ID_BYTES)
    this.id(id)
  }

  setKeyboardFocusDim(enabled: boolean): void {
    this.begin(WIRE_OPCODE.setKeyboardFocusDim, 1)
    this.bytes[this.position++] = enabled ? 1 : 0
  }

  /** `null` clears the layer; otherwise the `JSON.stringify` text of the style. */
  setUniversalStyle(styleJson: string | null): void {
    this.begin(WIRE_OPCODE.setUniversalStyle, stringBound(styleJson ?? ""))
    this.string(styleJson ?? "")
  }

  setCustomProp(id: number, key: string, value: WireValue): void {
    switch (typeof value) {
      case "string":
        this.begin(WIRE_OPCODE.setCustomProp, MAX_ID_BYTES + stringBound(key) + 1 + stringBound(value))
        this.id(id)
        this.string(key)
        this.bytes[this.position++] = WIRE_VALUE_TAG.string
        this.string(value)
        return
      case "number":
        this.begin(WIRE_OPCODE.setCustomProp, MAX_ID_BYTES + stringBound(key) + 1 + 8)
        this.id(id)
        this.string(key)
        this.number(value)
        return
      case "boolean":
        this.begin(WIRE_OPCODE.setCustomProp, MAX_ID_BYTES + stringBound(key) + 1)
        this.id(id)
        this.string(key)
        this.bytes[this.position++] = value ? WIRE_VALUE_TAG.true : WIRE_VALUE_TAG.false
        return
      case "object": {
        // `JSON.stringify` is what the JSON path wrote: a `toJSON` is honored, and what it
        // cannot hold (a function, `undefined`) becomes `null` or is dropped the same way.
        const json = value === null ? undefined : JSON.stringify(value)
        if (json === undefined) return this.nullProp(id, key)
        this.begin(WIRE_OPCODE.setCustomProp, MAX_ID_BYTES + stringBound(key) + 1 + stringBound(json))
        this.id(id)
        this.string(key)
        this.bytes[this.position++] = WIRE_VALUE_TAG.json
        this.string(json)
        return
      }
      case "bigint":
        throw new TypeError("A custom prop value cannot be a bigint")
      default:
        // `undefined`, a function or a symbol: `JSON.stringify` writes `null` for each in an array.
        return this.nullProp(id, key)
    }
  }

  /** `null` removes the attribute. */
  setAttribute(id: number, name: string, value: string | null): void {
    this.begin(
      WIRE_OPCODE.setAttribute,
      MAX_ID_BYTES + stringBound(name) + 1 + (value === null ? 0 : stringBound(value))
    )
    this.id(id)
    this.string(name)
    if (value === null) {
      this.bytes[this.position++] = 0
      return
    }
    this.bytes[this.position++] = 1
    this.string(value)
  }

  /** A constructed stylesheet; `null` deletes it. Sheet ids are their own namespace. */
  setStyleSheet(sheetId: number, text: string | null): void {
    this.begin(WIRE_OPCODE.setStyleSheet, MAX_ID_BYTES + 1 + (text === null ? 0 : stringBound(text)))
    this.id(sheetId)
    if (text === null) {
      this.bytes[this.position++] = 0
      return
    }
    this.bytes[this.position++] = 1
    this.string(text)
  }

  /** The constructed sheets that apply, in order, after the `<style>` elements of the document. */
  setAdoptedStyleSheets(sheetIds: readonly number[]): void {
    this.begin(WIRE_OPCODE.setAdoptedStyleSheets, (1 + sheetIds.length) * MAX_ID_BYTES)
    this.id(sheetIds.length)
    for (const sheetId of sheetIds) this.id(sheetId)
  }

  /** The batch written so far, and the writer ready for the next one. */
  finish(): WireBatch {
    writeHeader(this.bytes, this.count)
    const batch = this.free.pop() ?? new WireBatch()
    const bytes = this.bytes
    const view = this.view
    const offsets = this.offsets
    this.bytes = batch.bytes
    this.view = batch.view
    this.offsets = batch.offsets
    batch.bytes = bytes
    batch.view = view
    batch.offsets = offsets
    batch.count = this.count
    batch.length = this.position
    this.clear()
    return batch
  }

  /** The batch was applied: its buffers can be written again. */
  release(batch: WireBatch): void {
    if (batch.bytes.length > RETAINED_CAPACITY) {
      // One huge batch is not kept for the life of the app.
      batch.bytes = new Uint8Array(INITIAL_CAPACITY)
      batch.view = new DataView(batch.bytes.buffer)
    }
    if (batch.offsets.length > RETAINED_OPS) batch.offsets = new Uint32Array(INITIAL_OPS)
    this.free.push(batch)
  }

  /** The batch was not applied: its ops go in front of what was written since, and its buffers are released. */
  recover(batch: WireBatch): void {
    const added = batch.length - HEADER_BYTES
    if (this.position + added > this.bytes.length) this.grow(added)
    if (this.count + batch.count > this.offsets.length) this.growOffsets(this.count + batch.count)
    this.bytes.copyWithin(HEADER_BYTES + added, HEADER_BYTES, this.position)
    this.bytes.set(batch.bytes.subarray(HEADER_BYTES, batch.length), HEADER_BYTES)
    this.offsets.copyWithin(batch.count, 0, this.count)
    for (let index = batch.count; index < this.count + batch.count; index++) this.offsets[index] += added
    this.offsets.set(batch.offsets.subarray(0, batch.count), 0)
    this.position += added
    this.count += batch.count
    this.opStart += added
    this.release(batch)
  }

  /** Drop what was written without producing a batch. */
  clear(): void {
    this.position = HEADER_BYTES
    this.opStart = HEADER_BYTES
    this.count = 0
  }

  private nullProp(id: number, key: string): void {
    this.begin(WIRE_OPCODE.setCustomProp, MAX_ID_BYTES + stringBound(key) + 1)
    this.id(id)
    this.string(key)
    this.bytes[this.position++] = WIRE_VALUE_TAG.null
  }

  /** Reserve room for an op of at most `bound` bytes after its opcode and write the opcode. */
  private begin(opcode: number, bound: number): void {
    if (this.position + 1 + bound > this.bytes.length) this.grow(1 + bound)
    if (this.count === this.offsets.length) this.growOffsets(this.count + 1)
    this.opStart = this.position
    this.offsets[this.count++] = this.position
    this.bytes[this.position++] = opcode
  }

  private grow(extra: number): void {
    const bytes = new Uint8Array(Math.max(this.bytes.length * 2, this.position + extra))
    bytes.set(this.bytes.subarray(0, this.position))
    this.bytes = bytes
    this.view = new DataView(bytes.buffer)
  }

  private growOffsets(needed: number): void {
    const offsets = new Uint32Array(Math.max(this.offsets.length * 2, needed))
    offsets.set(this.offsets.subarray(0, this.count))
    this.offsets = offsets
  }

  private abort(message: string): never {
    this.position = this.opStart
    this.count--
    throw new RangeError(message)
  }

  private id(id: number): void {
    const bytes = this.bytes
    // One comparison is the whole check for the common id: it holds for a
    // uint32 and for nothing else, not a negative, a fraction, NaN or a large number.
    if ((id >>> 0) === id) {
      let rest = id
      let position = this.position
      while (rest >= 0x80) {
        bytes[position++] = (rest & 0x7f) | 0x80
        rest >>>= 7
      }
      bytes[position++] = rest
      this.position = position
      return
    }
    if (!Number.isSafeInteger(id) || id < 0) {
      this.abort(`Invalid element id: ${id}. It must be a non-negative integer up to ${MAX_SAFE_ID}.`)
    }
    // Above 2^32 the bit operators no longer see the whole number.
    let rest = id
    let position = this.position
    while (rest >= 0x80) {
      bytes[position++] = (rest % 0x80) | 0x80
      rest = Math.floor(rest / 0x80)
    }
    bytes[position++] = rest
    this.position = position
  }

  /** Length-prefixed UTF-8. The caller reserved `stringBound(value)`. */
  private string(value: string): void {
    const length = value.length
    // The byte length is known only after the copy, so the prefix is as wide as
    // the worst case needs and padded to it, which saves moving the bytes back.
    const width = varintWidth(length * 3)
    const start = this.position + width
    const end = length <= SHORT_STRING ? this.copyShort(value, start) : this.encodeFrom(value, start)
    writePadded(this.bytes, this.position, end - start, width)
    this.position = end
  }

  private copyShort(value: string, start: number): number {
    const bytes = this.bytes
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index)
      if (unit > 0x7f) return this.encodeFrom(value, start)
      bytes[start + index] = unit
    }
    return start + value.length
  }

  private encodeFrom(value: string, start: number): number {
    // Unpaired surrogates in a plain string become U+FFFD. A style or JSON-valued custom prop is already JSON text, where
    // `JSON.stringify` wrote the unpaired surrogate as the escape `\ud800`; native's JSON parser rejects that and refuses the batch.
    if (this.encoder === undefined) return encodeUtf8(value, this.bytes, start)
    return start + this.encoder.encodeInto(value, this.bytes.subarray(start)).written
  }

  private number(value: number): void {
    const bytes = this.bytes
    if (Number.isSafeInteger(value)) {
      // `-0` is not below zero and is written as 0, as `JSON.stringify` does.
      if (value < 0) {
        bytes[this.position++] = WIRE_VALUE_TAG.negativeInt
        this.id(-value)
      } else {
        bytes[this.position++] = WIRE_VALUE_TAG.uint
        this.id(value)
      }
    } else if (Number.isFinite(value)) {
      bytes[this.position++] = WIRE_VALUE_TAG.float
      this.view.setFloat64(this.position, value, true)
      this.position += 8
    } else {
      // NaN and the infinities are `null` in JSON.
      bytes[this.position++] = WIRE_VALUE_TAG.null
    }
  }
}

/** The most bytes a length-prefixed string takes: the prefix, then at most three bytes a UTF-16 unit. */
function stringBound(value: string): number {
  return 5 + value.length * 3
}

/** `value` as a varint of exactly `width` bytes, zero-padded with continuation bits. */
function writePadded(bytes: Uint8Array, at: number, value: number, width: number): void {
  let rest = value
  for (let index = 0; index < width - 1; index++) {
    bytes[at + index] = (rest % 0x80) | 0x80
    rest = Math.floor(rest / 0x80)
  }
  bytes[at + width - 1] = rest
}

/** The version byte sits directly in front of the count, which fills its reserved width, so the batch starts at the first byte. */
function writeHeader(bytes: Uint8Array, count: number): void {
  bytes[0] = WIRE_FORMAT_VERSION
  writePadded(bytes, 1, count, COUNT_WIDTH)
}

/** UTF-8 of `value` at `start`; the end of what it wrote. Unpaired surrogates become U+FFFD, as `TextEncoder` does. */
function encodeUtf8(value: string, bytes: Uint8Array, start: number): number {
  let position = start
  for (let index = 0; index < value.length; index++) {
    let unit = value.charCodeAt(index)
    if (unit < 0x80) {
      bytes[position++] = unit
    } else if (unit < 0x800) {
      bytes[position++] = 0xc0 | (unit >> 6)
      bytes[position++] = 0x80 | (unit & 0x3f)
    } else {
      if (unit >= 0xd800 && unit < 0xe000) {
        const next = unit < 0xdc00 && index + 1 < value.length ? value.charCodeAt(index + 1) : 0
        if (next >= 0xdc00 && next < 0xe000) {
          const point = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00)
          index++
          bytes[position++] = 0xf0 | (point >> 18)
          bytes[position++] = 0x80 | ((point >> 12) & 0x3f)
          bytes[position++] = 0x80 | ((point >> 6) & 0x3f)
          bytes[position++] = 0x80 | (point & 0x3f)
          continue
        }
        unit = 0xfffd
      }
      bytes[position++] = 0xe0 | (unit >> 12)
      bytes[position++] = 0x80 | ((unit >> 6) & 0x3f)
      bytes[position++] = 0x80 | (unit & 0x3f)
    }
  }
  return position
}

function varintWidth(value: number): number {
  if (value < 0x80) return 1
  if (value < 0x4000) return 2
  if (value < 0x200000) return 3
  if (value < 0x10000000) return 4
  return 5
}
