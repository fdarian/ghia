/**
 * Writer for the binary mutation batch. Rust reads it in `src/batch/wire.rs`; the
 * format is specified in `docs/reference.md` ("Wire format"). Opcodes and value
 * tags are the same numbers in both files, so change them together.
 *
 * One growable buffer is reused for every batch, so writing an op allocates
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
 * Builds one batch at a time. `finish()` returns its bytes and starts the next.
 *
 * The bytes `finish()` returns are a view of the writer's own buffer, valid
 * until the next call that writes: consume them (hand them to native, which
 * copies what it keeps) before the next op is written.
 *
 * A method that throws (an id that is not a non-negative safe integer) leaves
 * the batch as it was before the call.
 */
export class WireWriter {
  private bytes = new Uint8Array(INITIAL_CAPACITY)
  private view = new DataView(this.bytes.buffer)
  private position = HEADER_BYTES
  private opStart = HEADER_BYTES
  private count = 0
  private readonly encoder = new TextEncoder()

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

  /**
   * The batch written so far, header included, and the writer ready for the
   * next one. The returned bytes are overwritten by the next write.
   */
  finish(): Uint8Array {
    // The version byte sits directly in front of the count, which fills its
    // reserved width, so the batch starts at the first byte.
    this.bytes[0] = WIRE_FORMAT_VERSION
    this.padded(1, this.count, COUNT_WIDTH)
    const batch = this.bytes.subarray(0, this.position)
    this.clear()
    if (this.bytes.length > RETAINED_CAPACITY) {
      // `batch` keeps the large buffer alive until its caller is done with it.
      this.bytes = new Uint8Array(INITIAL_CAPACITY)
      this.view = new DataView(this.bytes.buffer)
    }
    return batch
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
    this.opStart = this.position
    this.count++
    this.bytes[this.position++] = opcode
  }

  private grow(extra: number): void {
    const bytes = new Uint8Array(Math.max(this.bytes.length * 2, this.position + extra))
    bytes.set(this.bytes.subarray(0, this.position))
    this.bytes = bytes
    this.view = new DataView(bytes.buffer)
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

  /** `value` as a varint of exactly `width` bytes, zero-padded with continuation bits. */
  private padded(at: number, value: number, width: number): void {
    const bytes = this.bytes
    let rest = value
    for (let index = 0; index < width - 1; index++) {
      bytes[at + index] = (rest % 0x80) | 0x80
      rest = Math.floor(rest / 0x80)
    }
    bytes[at + width - 1] = rest
  }

  /** Length-prefixed UTF-8. The caller reserved `stringBound(value)`. */
  private string(value: string): void {
    const length = value.length
    // The byte length is known only after the copy, so the prefix is as wide as
    // the worst case needs and padded to it, which saves moving the bytes back.
    const width = varintWidth(length * 3)
    const start = this.position + width
    const end = length <= SHORT_STRING ? this.copyShort(value, start) : this.encodeFrom(value, start)
    this.padded(this.position, end - start, width)
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
    // Unpaired surrogates become U+FFFD, where `JSON.stringify` would have escaped them and native refused the batch.
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

function varintWidth(value: number): number {
  if (value < 0x80) return 1
  if (value < 0x4000) return 2
  if (value < 0x200000) return 3
  if (value < 0x10000000) return 4
  return 5
}
