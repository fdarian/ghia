/**
 * The macOS pasteboard behind `writeClipboard` and `readClipboard`, on a pasteboard this test
 * makes: the general one is the person's, and a test never writes it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as native from "../../index.js"

const describeLive = native.hasTestGpuixRenderer() && process.platform === "darwin" ? describe : describe.skip

describeLive("a named pasteboard", () => {
  let name: string

  beforeAll(() => {
    name = native.createTestPasteboard()
  })

  afterAll(() => {
    native.releaseTestPasteboard(name)
  })

  it("round-trips the types of a rich-text copy", () => {
    const entries = [
      { type: "text/plain", data: "héllo \u{1F30D}" },
      { type: "text/html", data: "<b>héllo</b>" },
      { type: "text/uri-list", data: "https://a.test/\nhttps://b.test/" },
      { type: "application/x-lexical-editor", data: '{"namespace":"x","nodes":[]}' },
    ]
    native.writeClipboardTo(name, entries)
    expect(native.readClipboardFrom(name)).toEqual(entries)
  })

  it("replaces the previous contents", () => {
    native.writeClipboardTo(name, [{ type: "application/x-a", data: "1" }])
    native.writeClipboardTo(name, [{ type: "text/plain", data: "b" }])
    expect(native.readClipboardFrom(name)).toEqual([{ type: "text/plain", data: "b" }])
  })

  it("refuses a pasteboard it did not make", () => {
    expect(() => native.readClipboardFrom("Apple CFPasteboard general")).toThrow("not a test pasteboard")
    expect(() => native.writeClipboardTo("Apple CFPasteboard general", [])).toThrow("not a test pasteboard")
  })
})
