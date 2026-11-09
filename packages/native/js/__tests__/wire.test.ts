import { describe, expect, it } from "vitest"
import { decodeJsonBatchForTest, decodeWireBatchForTest } from "../testing.js"
import { WireWriter, type WireValue } from "../wire.js"

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
  return writer.finish()
}

/** What the JSON path makes of the ops, and what the binary path makes of the same ops. */
function decodedBoth(tuples: readonly Tuple[]): { json: string[]; wire: string[] } {
  return {
    json: decodeJsonBatchForTest(JSON.stringify(tuples)),
    wire: decodeWireBatchForTest(encode(tuples)),
  }
}

function expectSameAsJson(tuples: readonly Tuple[]): void {
  const decoded = decodedBoth(tuples)
  expect(decoded.wire).toHaveLength(tuples.length)
  expect(decoded.wire).toEqual(decoded.json)
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

describe("WireWriter against the JSON decoder", () => {
  it("reads every op kind as the JSON path does", () => {
    expectSameAsJson([
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
    expect(decodeWireBatchForTest(new WireWriter().finish())).toEqual([])
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
    expectSameAsJson(tuples)
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
    expectSameAsJson(tuples)
  })

  it("reads every style shape as the exact JSON text", () => {
    const tuples: Tuple[] = STYLES.map((style, index): Tuple => ["setStyle", index + 1, style])
    tuples.push(...STYLES.map((style): Tuple => ["setUniversalStyle", style]))
    expectSameAsJson(tuples)
  })

  it("hands native the style text byte for byte", () => {
    const style = { b: 1, a: undefined, c: { d: Number.NaN, e: -0 }, f: [1, 2] }
    const text = JSON.stringify(style)
    const lines = decodeWireBatchForTest(encode([["setStyle", 9, style]]))
    expect(lines).toEqual([`SetStyle { id: 9, style: ${JSON.stringify(text)} }`])
    // Key order is the order written.
    expect(text).toBe('{"b":1,"c":{"d":null,"e":0},"f":[1,2]}')
  })

  it("reads every custom prop value as the JSON path does", () => {
    expectSameAsJson(
      CUSTOM_PROP_VALUES.map((value, index): Tuple => ["setCustomProp", index, "key", value])
    )
  })

  it("reads random batches as the JSON path does", () => {
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
      expectSameAsJson(tuples)
    }
  })

  it("reads one batch that is larger than the starting buffer", () => {
    const tuples: Tuple[] = []
    for (let index = 0; index < 20000; index++) {
      tuples.push(["createElement", index, "div"], ["setStyle", index, STYLES[4] as object])
    }
    expectSameAsJson(tuples)
  })
})

describe("WireWriter", () => {
  it("replaces unpaired surrogates with U+FFFD", () => {
    const lines = decodeWireBatchForTest(encode([["setText", 1, "a\ud800b"]]))
    expect(lines).toEqual([`SetText { id: 1, content: ${JSON.stringify("a�b")} }`])
  })

  it("reuses its buffer: a batch is valid until the next write, and the next batch is unaffected", () => {
    const writer = new WireWriter()
    const first = encode([["createElement", 1, "div"], ["setText", 1, "first"]], writer)
    const firstLines = decodeWireBatchForTest(first)
    const second = encode([["createElement", 2, "span"]], writer)
    expect(second.buffer).toBe(first.buffer)
    expect(decodeWireBatchForTest(second)).toEqual(decodeJsonBatchForTest('[["createElement",2,"span"]]'))
    expect(firstLines).toHaveLength(2)
    expect(writer.opCount).toBe(0)
    expect(writer.byteLength).toBe(0)
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
    expect(decodeWireBatchForTest(writer.finish())).toEqual(decodeJsonBatchForTest('[["setRoot",5]]'))
  })

  it("lets go of a buffer one huge batch grew", () => {
    const writer = new WireWriter()
    const small = encode([["setRoot", 1]], writer)
    const smallBuffer = small.buffer
    writer.setText(1, "x".repeat(2 * 1024 * 1024))
    const huge = writer.finish()
    expect(huge.byteLength).toBeGreaterThan(2 * 1024 * 1024)
    const after = encode([["setRoot", 1]], writer)
    expect(after.buffer).not.toBe(huge.buffer)
    expect(after.buffer.byteLength).toBeLessThan(1024 * 1024)
    expect(smallBuffer.byteLength).toBeLessThan(1024 * 1024)
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
      expect(decodeWireBatchForTest(writer.finish())).toEqual(
        decodeJsonBatchForTest('[["createElement",1,"div"],["setRoot",1]]')
      )
    }
  )

  it("refuses a bigint custom prop value", () => {
    const writer = new WireWriter()
    expect(() => writer.setCustomProp(1, "k", 1n as unknown as WireValue)).toThrow(TypeError)
    expect(writer.opCount).toBe(0)
  })
})

describe("native decoder on bytes JS did not write", () => {
  const valid = (): Uint8Array => encode([["createElement", 1, "div"], ["setText", 1, "hi"]])

  it("refuses truncated input at every length", () => {
    const bytes = valid()
    for (let end = 0; end < bytes.length; end++) {
      expect(() => decodeWireBatchForTest(bytes.slice(0, end)), `${end} bytes`).toThrow()
    }
  })

  it("refuses an unknown version, an unknown opcode and trailing bytes", () => {
    const wrongVersion = valid().slice()
    wrongVersion[0] = 99
    expect(() => decodeWireBatchForTest(wrongVersion)).toThrow(/version 99/)
    const unknownOpcode = valid().slice()
    unknownOpcode[6] = 200
    expect(() => decodeWireBatchForTest(unknownOpcode)).toThrow(/Batch op 0: unknown operation 200/)
    const trailing = new Uint8Array([...valid(), 0])
    expect(() => decodeWireBatchForTest(trailing)).toThrow(/1 bytes remain/)
  })
})
