import { WIRE_FORMAT_VERSION, WIRE_OPCODE, WIRE_VALUE_TAG, WireWriter, type WireValue } from "./wire.js"

/**
 * An op in the tuple shape the JSON batch had, `[name, ...arguments]`. A style is
 * its parsed object, a `setUniversalStyle` of nothing is `null`.
 */
export type DecodedOp = [string, ...unknown[]]

const OP_NAMES: Record<number, string> = {}
for (const [name, code] of Object.entries(WIRE_OPCODE)) OP_NAMES[code] = name

/**
 * Reads a batch the way native does, for tests that check what a queue sent. It
 * shares no code with `WireWriter`, so a test that writes with one and reads with
 * the other checks both against the format in `docs/reference.md`.
 */
export function decodeWireBatchForTest(bytes: Uint8Array): DecodedOp[] {
  let position = 0
  const decoder = new TextDecoder("utf-8", { fatal: true })

  const byte = (): number => {
    if (position >= bytes.length) throw new Error(`Batch ends early at byte ${position}`)
    return bytes[position++]
  }
  const varint = (): number => {
    let value = 0
    let scale = 1
    for (;;) {
      const next = byte()
      value += (next & 0x7f) * scale
      if ((next & 0x80) === 0) return value
      scale *= 0x80
    }
  }
  const string = (): string => {
    const length = varint()
    if (position + length > bytes.length) throw new Error(`String runs past the batch at byte ${position}`)
    const text = decoder.decode(bytes.subarray(position, position + length))
    position += length
    return text
  }
  const bool = (): boolean => {
    const value = byte()
    if (value > 1) throw new Error(`Boolean byte ${value} at byte ${position - 1}`)
    return value === 1
  }
  const value = (): unknown => {
    const tag = byte()
    switch (tag) {
      case WIRE_VALUE_TAG.null:
        return null
      case WIRE_VALUE_TAG.false:
        return false
      case WIRE_VALUE_TAG.true:
        return true
      case WIRE_VALUE_TAG.uint:
        return varint()
      case WIRE_VALUE_TAG.negativeInt:
        return -varint()
      case WIRE_VALUE_TAG.float: {
        const number = new DataView(bytes.buffer, bytes.byteOffset + position, 8).getFloat64(0, true)
        position += 8
        return number
      }
      case WIRE_VALUE_TAG.string:
        return string()
      case WIRE_VALUE_TAG.json:
        return JSON.parse(string())
      default:
        throw new Error(`Unknown value tag ${tag}`)
    }
  }

  const version = byte()
  if (version !== WIRE_FORMAT_VERSION) throw new Error(`Batch format version ${version}`)
  const count = varint()
  const ops: DecodedOp[] = []
  for (let index = 0; index < count; index++) {
    const code = byte()
    const name = OP_NAMES[code]
    switch (code) {
      case WIRE_OPCODE.createElement:
        ops.push([name, varint(), string()])
        break
      case WIRE_OPCODE.destroyElement:
      case WIRE_OPCODE.detachChild:
      case WIRE_OPCODE.setRoot:
        ops.push([name, varint()])
        break
      case WIRE_OPCODE.appendChild:
        ops.push([name, varint(), varint()])
        break
      case WIRE_OPCODE.insertBefore:
        ops.push([name, varint(), varint(), varint()])
        break
      case WIRE_OPCODE.setStyle: {
        const id = varint()
        ops.push([name, id, JSON.parse(string())])
        break
      }
      case WIRE_OPCODE.setText:
        ops.push([name, varint(), string()])
        break
      case WIRE_OPCODE.setEventListener: {
        const id = varint()
        const type = string()
        ops.push([name, id, type, bool()])
        break
      }
      case WIRE_OPCODE.setKeyboardFocusDim:
        ops.push([name, bool()])
        break
      case WIRE_OPCODE.setUniversalStyle: {
        const text = string()
        ops.push([name, text === "" ? null : JSON.parse(text)])
        break
      }
      case WIRE_OPCODE.setCustomProp: {
        const id = varint()
        const key = string()
        ops.push([name, id, key, value()])
        break
      }
      default:
        throw new Error(`Unknown opcode ${code} at byte ${position - 1}`)
    }
  }
  if (position !== bytes.length) throw new Error(`${bytes.length - position} bytes remain after the last op`)
  return ops
}

/**
 * The bytes of a batch given as tuples, the shape the JSON batch had, for tests that hand a
 * renderer a batch of their own. Styles are the objects, as `decodeWireBatchForTest` returns them.
 */
export function encodeWireBatchForTest(ops: readonly DecodedOp[]): Uint8Array {
  const writer = new WireWriter()
  for (const op of ops) {
    switch (op[0]) {
      case "createElement":
        writer.createElement(op[1] as number, op[2] as string)
        break
      case "destroyElement":
        writer.destroyElement(op[1] as number)
        break
      case "detachChild":
        writer.detachChild(op[1] as number)
        break
      case "appendChild":
        writer.appendChild(op[1] as number, op[2] as number)
        break
      case "insertBefore":
        writer.insertBefore(op[1] as number, op[2] as number, op[3] as number)
        break
      case "setStyle":
        writer.setStyle(op[1] as number, JSON.stringify(op[2]))
        break
      case "setText":
        writer.setText(op[1] as number, op[2] as string)
        break
      case "setEventListener":
        writer.setEventListener(op[1] as number, op[2] as string, op[3] as boolean)
        break
      case "setRoot":
        writer.setRoot(op[1] as number)
        break
      case "setKeyboardFocusDim":
        writer.setKeyboardFocusDim(op[1] as boolean)
        break
      case "setUniversalStyle":
        writer.setUniversalStyle(op[1] === null ? null : JSON.stringify(op[1]))
        break
      case "setCustomProp":
        writer.setCustomProp(op[1] as number, op[2] as string, op[3] as WireValue)
        break
      default:
        throw new Error(`No wire opcode for ${String(op[0])}`)
    }
  }
  return writer.finish().wire
}
