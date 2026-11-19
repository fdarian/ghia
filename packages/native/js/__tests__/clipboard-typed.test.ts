/**
 * The test window's typed clipboard: an ordered list of `{ type, data }` entries in memory, with
 * `navigator.clipboard` text on top. Nothing here touches the system pasteboard.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { TestRenderer, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer && process.platform === "darwin" ? describe : describe.skip

describeNative("the test renderer's typed clipboard", () => {
  let renderer: TestRenderer

  beforeAll(() => {
    renderer = new TestRenderer({ width: 100, height: 100 })
  })

  beforeEach(() => {
    renderer.writeClipboard([])
  })

  afterAll(() => {
    renderer.dispose()
  })

  it("starts empty and reads back what was written, in order", () => {
    expect(renderer.readClipboard()).toEqual([])
    const entries = [
      { type: "text/plain", data: "héllo \u{1F30D}" },
      { type: "text/html", data: "<b>héllo</b>" },
      { type: "application/x-lexical-editor", data: '{"nodes":[]}' },
      { type: "text/uri-list", data: "https://a.test/\nhttps://b.test/" },
    ]
    renderer.writeClipboard(entries)
    expect(renderer.readClipboard()).toEqual(entries)
  })

  it("replaces the whole clipboard on a write", () => {
    renderer.writeClipboard([
      { type: "text/html", data: "<i>a</i>" },
      { type: "application/x-a", data: "1" },
    ])
    renderer.writeClipboard([{ type: "text/plain", data: "b" }])
    expect(renderer.readClipboard()).toEqual([{ type: "text/plain", data: "b" }])
  })

  it("keeps entries that have no text", () => {
    renderer.writeClipboard([{ type: "application/x-a", data: "1" }])
    expect(renderer.readClipboard()).toEqual([{ type: "application/x-a", data: "1" }])
  })

  it("is what navigator.clipboard reads and writes as text", async () => {
    renderer.writeClipboard([
      { type: "text/html", data: "<b>x</b>" },
      { type: "text/plain", data: "x" },
    ])
    expect(await navigator.clipboard.readText()).toBe("x")

    await navigator.clipboard.writeText("y")
    expect(renderer.readClipboard()).toEqual([{ type: "text/plain", data: "y" }])

    renderer.writeClipboard([{ type: "text/html", data: "<b>x</b>" }])
    expect(await navigator.clipboard.readText()).toBe("")
  })
})
