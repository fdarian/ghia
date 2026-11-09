import { describe, expect, it, vi } from "vitest"
import { decodeWireBatchForTest, decodeWireBatchWithNativeForTest } from "../testing.js"
import { WIRE_OPCODE, WireWriter, type WireValue } from "../wire.js"

type Tuple =
  | ["createElement", number, string]
  | ["destroyElement", number]
  | ["detachChild", number]
  | ["appendChild", number, number]
  | ["insertBefore", number, number, number]
  | ["setStyle", number, object]
  | ["setText", number, string]
  | ["setEventListener", number, string, boolean]
  | ["setRoot", number]
  | ["setKeyboardFocusDim", boolean]
  | ["setUniversalStyle", object | null]
  | ["setCustomProp", number, string, WireValue]

function write(writer: WireWriter, tuple: Tuple): void {
  switch (tuple[0]) {
    case "createElement":
      return writer.createElement(tuple[1], tuple[2])
    case "destroyElement":
      return writer.destroyElement(tuple[1])
    case "detachChild":
      return writer.detachChild(tuple[1])
    case "appendChild":
      return writer.appendChild(tuple[1], tuple[2])
    case "insertBefore":
      return writer.insertBefore(tuple[1], tuple[2], tuple[3])
    case "setStyle":
      return writer.setStyle(tuple[1], JSON.stringify(tuple[2]))
    case "setText":
      return writer.setText(tuple[1], tuple[2])
    case "setEventListener":
      return writer.setEventListener(tuple[1], tuple[2], tuple[3])
    case "setRoot":
      return writer.setRoot(tuple[1])
    case "setKeyboardFocusDim":
      return writer.setKeyboardFocusDim(tuple[1])
    case "setUniversalStyle":
      return writer.setUniversalStyle(tuple[1] === null ? null : JSON.stringify(tuple[1]))
    case "setCustomProp":
      return writer.setCustomProp(tuple[1], tuple[2], tuple[3])
  }
}

function encode(tuples: readonly Tuple[], writer = new WireWriter()): Uint8Array {
  for (const tuple of tuples) write(writer, tuple)
  return writer.finish().wire
}

/**
 * What a decoder must read back from `tuples`: what `JSON.stringify` makes of each op, which is
 * what a custom prop or style is by definition (`undefined` is `null`, `NaN` is `null`, `-0` is 0).
 */
function expectedOps(tuples: readonly Tuple[]): unknown[] {
  return JSON.parse(JSON.stringify(tuples))
}

/** Both decoders, the native one and the test helper's, read exactly the ops that were written. */
function expectRoundTrip(tuples: readonly Tuple[]): void {
  const bytes = encode(tuples)
  const expected = expectedOps(tuples)
  expect(decodeWireBatchWithNativeForTest(bytes).map((line) => JSON.parse(line))).toEqual(expected)
  expect(decodeWireBatchForTest(bytes)).toEqual(expected)
}

/** The ops of a batch as native reads them, in the tuple shape. */
function nativeOps(bytes: Uint8Array): unknown[] {
  return decodeWireBatchWithNativeForTest(bytes).map((line) => JSON.parse(line))
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER

const STYLES: object[] = [
  {},
  { width: 10 },
  { display: "flex", flexDirection: "column", gap: 8, padding: 8, paddingLeft: 4 },
  { color: "#112233", backgroundColor: "rgba(0, 0, 0, 0.5)", opacity: 0.25 },
  {
    width: "100%",
    hover: { backgroundColor: "red", active: { color: "blue" } },
    active: { opacity: 0.5 },
    focusVisible: { outline: "2px solid blue" },
    "@container (min-width: 300px)": { flexDirection: "row", hover: { gap: 2 } },
  },
  {
    transition: "opacity 200ms ease-out, transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
    animation: "fade 1s infinite alternate",
    transform: "translateX(10px) rotate(3deg)",
    willChange: "transform",
  },
  {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gridTemplateAreas: '"a b" "c d"',
    backgroundImage: "url(blob:abc) , linear-gradient(to right, red, blue)",
  },
  { fontFamily: '"Inter", sans-serif', content: "quote \" backslash \\ newline \n tab \t", label: "é 日本語 😀  " },
  { "日本語": 1, emoji: "😀" },
]

const CUSTOM_PROP_VALUES: WireValue[] = [
  null,
  undefined,
  true,
  false,
  "",
  "a string",
  "日本語 😀",
  0,
  -0,
  1,
  -1,
  127,
  128,
  300,
  2 ** 31,
  2 ** 32,
  2 ** 32 + 1,
  MAX_SAFE,
  -MAX_SAFE,
  1.5,
  -2.25,
  0.1,
  1e21,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  {},
  [],
  { message: "boom", ticket: 7 },
  { x: 1, y: [1, 2, { z: null }], s: "😀" },
  [1, "two", null, { three: 3 }],
  { motion: { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2 } } },
  { toJSON: () => ({ replaced: true }) },
]

describe("WireWriter round trip", () => {
  it("reads every op kind back", () => {
    expectRoundTrip([
      ["createElement", 1, "div"],
      ["createElement", 2, "text"],
      ["appendChild", 1, 2],
      ["insertBefore", 1, 3, 2],
      ["detachChild", 3],
      ["destroyElement", 3],
      ["setStyle", 1, { width: 10 }],
      ["setText", 2, "hello"],
      ["setEventListener", 1, "pointerdown", true],
      ["setEventListener", 1, "pointerdown", false],
      ["setRoot", 1],
      ["setKeyboardFocusDim", true],
      ["setKeyboardFocusDim", false],
      ["setUniversalStyle", { color: "red" }],
      ["setUniversalStyle", null],
      ["setCustomProp", 1, "testId", "x"],
    ])
  })

  it("reads an empty batch", () => {
    expect(decodeWireBatchForTest(new WireWriter().finish().wire)).toEqual([])
  })

  it("reads ids around every varint width, 2^32 and the largest safe integer", () => {
    const ids = [
      0, 1, 127, 128, 255, 16383, 16384, 2 ** 21 - 1, 2 ** 21, 2 ** 28 - 1, 2 ** 28, 2 ** 31 - 1, 2 ** 31,
      2 ** 32 - 1, 2 ** 32, 2 ** 32 + 1, 2 ** 35, 2 ** 40 + 12345, 2 ** 49, 2 ** 52 + 1, MAX_SAFE - 1, MAX_SAFE,
    ]
    const tuples: Tuple[] = ids.flatMap((id): Tuple[] => [
      ["createElement", id, "div"],
      ["appendChild", id, MAX_SAFE],
      ["insertBefore", MAX_SAFE, id, 2 ** 32],
      ["destroyElement", id],
      ["setRoot", id],
    ])
    expectRoundTrip(tuples)
  })

  it("reads strings of every shape", () => {
    const strings = [
      "",
      "a",
      "div",
      "x".repeat(32),
      "x".repeat(33),
      "x".repeat(42),
      "x".repeat(43),
      "x".repeat(127),
      "x".repeat(128),
      "x".repeat(5000),
      "x".repeat(5462),
      "é",
      "é".repeat(100),
      "日本語",
      "日本語".repeat(2000),
      "😀",
      "😀".repeat(50),
      "a😀b",
      "ab".repeat(16) + "é",
      "😀".repeat(2000),
      "tab\tnewline\nquote\"backslash\\nul\u0000bell\u0007",
      "  ﻿￿",
    ]
    const tuples: Tuple[] = strings.flatMap((text, index): Tuple[] => [
      ["createElement", index, text],
      ["setText", index, text],
      ["setEventListener", index, text, index % 2 === 0],
      ["setCustomProp", index, text, text],
    ])
    expectRoundTrip(tuples)
  })

  it("keeps a leading U+FEFF in a string, as native does", () => {
    const tuples: Tuple[] = [
      ["setText", 1, "\uFEFF"],
      ["setText", 2, "\uFEFFtext"],
      ["setCustomProp", 3, "\uFEFFkey", "\uFEFFvalue"],
    ]
    expectRoundTrip(tuples)
    expect(decodeWireBatchForTest(encode(tuples))[1]).toEqual(["setText", 2, "\uFEFFtext"])
  })

  it("reads every style shape as the exact JSON text", () => {
    const tuples: Tuple[] = STYLES.map((style, index): Tuple => ["setStyle", index + 1, style])
    tuples.push(...STYLES.map((style): Tuple => ["setUniversalStyle", style]))
    expectRoundTrip(tuples)
  })

  it("hands native the style text byte for byte", () => {
    const style = { b: 1, a: undefined, c: { d: Number.NaN, e: -0 }, f: [1, 2] }
    const text = JSON.stringify(style)
    // The raw line keeps the style as the text that was written, which a parsed comparison cannot show.
    const lines = decodeWireBatchWithNativeForTest(encode([["setStyle", 9, style]]))
    expect(lines).toEqual([`["setStyle",9,${text}]`])
    // Key order is the order written.
    expect(text).toBe('{"b":1,"c":{"d":null,"e":0},"f":[1,2]}')
  })

  it("reads every custom prop value back as its JSON", () => {
    expectRoundTrip(
      CUSTOM_PROP_VALUES.map((value, index): Tuple => ["setCustomProp", index, "key", value])
    )
  })

  it("reads random batches back", () => {
    // A small seeded generator, so a failure is reproducible.
    let seed = 0x2545f491
    const next = (): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 2 ** 32
    }
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
    const id = (): number => (next() < 0.1 ? Math.floor(next() * MAX_SAFE) : Math.floor(next() * 5000))
    const text = (): string => {
      const alphabet = ["a", "b", " ", "é", "日", "😀", "\n", '"', "\\"]
      return Array.from({ length: Math.floor(next() * 80) }, () => pick(alphabet)).join("")
    }
    for (let round = 0; round < 30; round++) {
      const tuples: Tuple[] = []
      for (let index = 0; index < 200; index++) {
        const roll = Math.floor(next() * 12)
        tuples.push(
          roll === 0 ? ["createElement", id(), pick(["div", "text", "span", text()])]
          : roll === 1 ? ["destroyElement", id()]
          : roll === 2 ? ["detachChild", id()]
          : roll === 3 ? ["appendChild", id(), id()]
          : roll === 4 ? ["insertBefore", id(), id(), id()]
          : roll === 5 ? ["setStyle", id(), pick(STYLES)]
          : roll === 6 ? ["setText", id(), text()]
          : roll === 7 ? ["setEventListener", id(), pick(["click", text()]), next() < 0.5]
          : roll === 8 ? ["setRoot", id()]
          : roll === 9 ? ["setKeyboardFocusDim", next() < 0.5]
          : roll === 10 ? ["setUniversalStyle", next() < 0.3 ? null : pick(STYLES)]
          : ["setCustomProp", id(), text(), pick(CUSTOM_PROP_VALUES)]
        )
      }
      expectRoundTrip(tuples)
    }
  })

  it("reads one batch that is larger than the starting buffer", () => {
    const tuples: Tuple[] = []
    for (let index = 0; index < 20000; index++) {
      tuples.push(["createElement", index, "div"], ["setStyle", index, STYLES[4] as object])
    }
    expectRoundTrip(tuples)
  })
})

describe("WireWriter", () => {
  it("replaces unpaired surrogates with U+FFFD", () => {
    expect(nativeOps(encode([["setText", 1, "a\ud800b"]]))).toEqual([["setText", 1, "a�b"]])
  })

  it("writes long ASCII, long non-ASCII and mixed strings as TextEncoder would", () => {
    const ascii = "The quick brown fox, 0123456789 {\"a\":1}. ".repeat(200)
    const strings = [
      ascii,
      "é" + ascii,
      ascii + "é",
      ascii + "日本語" + ascii,
      ascii + "😀" + ascii,
      ascii.slice(0, 40) + "\ud800" + ascii,
      ascii + "\udc00",
      "日本語".repeat(500) + ascii,
      "é".repeat(1000),
      "😀".repeat(1000) + ascii.slice(0, 3),
    ]
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const tuples: Tuple[] = strings.map((text, index): Tuple => ["setText", index + 1, text])
    expect(nativeOps(encode(tuples))).toEqual(
      strings.map((text, index) => ["setText", index + 1, decoder.decode(encoder.encode(text))])
    )
  })

  it("writes the next batch in another buffer, so a batch in flight is never overwritten", () => {
    const writer = new WireWriter()
    writer.createElement(1, "div")
    writer.setText(1, "first")
    const inFlight = writer.finish()
    const before = inFlight.wire.slice()
    writer.createElement(2, "span")
    const second = writer.finish()
    expect(second.bytes.buffer).not.toBe(inFlight.bytes.buffer)
    expect(inFlight.wire).toEqual(before)
    expect(decodeWireBatchForTest(inFlight.wire)).toEqual([["createElement", 1, "div"], ["setText", 1, "first"]])
    expect(decodeWireBatchForTest(second.wire)).toEqual([["createElement", 2, "span"]])
    expect(writer.opCount).toBe(0)
    expect(writer.byteLength).toBe(0)
  })

  it("reuses the buffers of released batches and allocates none in the steady state", () => {
    const writer = new WireWriter()
    const seen = new Set<ArrayBufferLike>()
    for (let round = 0; round < 6; round++) {
      writer.createElement(round, "div")
      const batch = writer.finish()
      seen.add(batch.bytes.buffer)
      writer.release(batch)
    }
    // The one it writes into and the one it hands out.
    expect(seen.size).toBeLessThanOrEqual(2)
  })

  it("gives a batch finished inside another's apply a buffer of its own", () => {
    const writer = new WireWriter()
    writer.createElement(1, "div")
    const outer = writer.finish()
    writer.createElement(2, "div")
    const inner = writer.finish()
    writer.createElement(3, "div")
    const next = writer.finish()
    const buffers = new Set([outer.bytes.buffer, inner.bytes.buffer, next.bytes.buffer])
    expect(buffers.size).toBe(3)
    expect(decodeWireBatchForTest(outer.wire)).toEqual([["createElement", 1, "div"]])
  })

  it("counts ops and bytes written", () => {
    const writer = new WireWriter()
    writer.createElement(1, "div")
    writer.setRoot(1)
    expect(writer.opCount).toBe(2)
    // opcode, id, length, "div"; opcode, id
    expect(writer.byteLength).toBe(1 + 1 + 1 + 3 + 1 + 1)
  })

  it("clear drops what was written", () => {
    const writer = new WireWriter()
    writer.createElement(1, "div")
    writer.clear()
    writer.setRoot(5)
    expect(decodeWireBatchForTest(writer.finish().wire)).toEqual([["setRoot", 5]])
  })

  it("lets go of a buffer one huge batch grew", () => {
    const writer = new WireWriter()
    writer.setText(1, "x".repeat(2 * 1024 * 1024))
    const huge = writer.finish()
    expect(huge.wire.byteLength).toBeGreaterThan(2 * 1024 * 1024)
    writer.release(huge)
    writer.setRoot(1)
    const small = writer.finish()
    writer.release(small)
    writer.setRoot(2)
    const after = writer.finish()
    expect(after.bytes.byteLength).toBeLessThan(1024 * 1024)
    expect(small.bytes.byteLength).toBeLessThan(1024 * 1024)
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_SAFE + 1, 2 ** 53 + 2])(
    "refuses id %s and leaves the batch as it was",
    (id) => {
      const writer = new WireWriter()
      writer.createElement(1, "div")
      expect(() => writer.appendChild(1, id)).toThrow(/Invalid element id/)
      expect(() => writer.createElement(id, "span")).toThrow(/Invalid element id/)
      expect(() => writer.insertBefore(1, 2, id)).toThrow(/Invalid element id/)
      expect(writer.opCount).toBe(1)
      writer.setRoot(1)
      expect(decodeWireBatchForTest(writer.finish().wire)).toEqual([["createElement", 1, "div"], ["setRoot", 1]])
    }
  )

  it("refuses a bigint custom prop value", () => {
    const writer = new WireWriter()
    expect(() => writer.setCustomProp(1, "k", 1n as unknown as WireValue)).toThrow(TypeError)
    expect(writer.opCount).toBe(0)
  })
})

describe("WireWriter recovery", () => {
  it("puts a batch that was not applied in front of what was written since", () => {
    const writer = new WireWriter()
    writer.createElement(1, "div")
    writer.setText(1, "failed")
    const failed = writer.finish()
    writer.createElement(2, "span")
    writer.setStyle(2, '{"width":1}')
    writer.recover(failed)
    expect(writer.opCount).toBe(4)
    writer.setRoot(1)
    const retried = writer.finish()
    expect(decodeWireBatchForTest(retried.wire)).toEqual([
      ["createElement", 1, "div"],
      ["setText", 1, "failed"],
      ["createElement", 2, "span"],
      ["setStyle", 2, { width: 1 }],
      ["setRoot", 1],
    ])
    // The offsets were moved with the bytes: a drop by index cuts the op that names it.
    retried.dropOp(3)
    expect(decodeWireBatchForTest(retried.wire).map((op) => op[0])).toEqual([
      "createElement",
      "setText",
      "createElement",
      "setRoot",
    ])
  })

  it("recovers into an empty writer and one that must grow", () => {
    const writer = new WireWriter()
    const text = "y".repeat(30000)
    writer.setText(1, text)
    writer.setText(2, text)
    const failed = writer.finish()
    for (let index = 0; index < 2000; index++) writer.createElement(index, "div")
    writer.recover(failed)
    const ops = decodeWireBatchForTest(writer.finish().wire)
    expect(ops).toHaveLength(2002)
    expect(ops[0]).toEqual(["setText", 1, text])
    expect(ops[1]).toEqual(["setText", 2, text])
    expect(ops[2002 - 1]).toEqual(["createElement", 1999, "div"])
  })

  it("cuts an op out by its byte range", () => {
    const writer = new WireWriter()
    writer.createElement(1, "div")
    writer.setStyle(1, '{"color":"red"}')
    writer.setStyle(1, '{"width":5}')
    writer.setText(1, "after")
    const batch = writer.finish()
    expect(batch.opcodeAt(1)).toBe(WIRE_OPCODE.setStyle)
    const length = batch.length
    batch.dropOp(1)
    expect(batch.count).toBe(3)
    expect(batch.length).toBeLessThan(length)
    expect(decodeWireBatchForTest(batch.wire)).toEqual([
      ["createElement", 1, "div"],
      ["setStyle", 1, { width: 5 }],
      ["setText", 1, "after"],
    ])
    batch.dropOp(2)
    batch.dropOp(0)
    expect(decodeWireBatchForTest(batch.wire)).toEqual([["setStyle", 1, { width: 5 }]])
    batch.dropOp(0)
    expect(decodeWireBatchForTest(batch.wire)).toEqual([])
  })
})

describe("WireWriter without TextEncoder", () => {
  it("writes the same bytes by hand", () => {
    const texts = ["", "ascii", "é", "日本語", "😀", "a😀b", "x".repeat(100) + "é", "lone \ud800 and \udc00 and \ud83d"]
    const tuples = texts.flatMap((text, index): Tuple[] => [
      ["createElement", index, text],
      ["setText", index, text],
      ["setCustomProp", index, text, [text]],
    ])
    const withEncoder = encode(tuples).slice()
    vi.stubGlobal("TextEncoder", undefined)
    try {
      const byHand = encode(tuples).slice()
      expect(byHand).toEqual(withEncoder)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("native decoder on bytes JS did not write", () => {
  const valid = (): Uint8Array => encode([["createElement", 1, "div"], ["setText", 1, "hi"]])

  it("refuses truncated input at every length", () => {
    const bytes = valid()
    for (let end = 0; end < bytes.length; end++) {
      expect(() => decodeWireBatchWithNativeForTest(bytes.slice(0, end)), `${end} bytes`).toThrow()
    }
  })

  it("refuses an unknown version, an unknown opcode and trailing bytes", () => {
    const wrongVersion = valid().slice()
    wrongVersion[0] = 99
    expect(() => decodeWireBatchWithNativeForTest(wrongVersion)).toThrow(/version 99/)
    const unknownOpcode = valid().slice()
    unknownOpcode[6] = 200
    expect(() => decodeWireBatchWithNativeForTest(unknownOpcode)).toThrow(/Batch op 0: unknown operation 200/)
    const trailing = new Uint8Array([...valid(), 0])
    expect(() => decodeWireBatchWithNativeForTest(trailing)).toThrow(/1 bytes remain/)
  })
})
