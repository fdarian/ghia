/// A sheet's `@font-face` registers the face with the window's text system under the family the rule names, which the
/// file need not (GpuixTestSquare: "A" and "m" are one em wide, "B" two).
import fs from "fs"
import { fileURLToPath } from "url"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const SQUARE_URL = new URL("../../../react/src/__tests__/fixtures/gpuix-test-square.ttf", import.meta.url)
const SQUARE_PATH = fileURLToPath(SQUARE_URL)
const SQUARE_DATA_URL = `data:font/ttf;base64,${fs.readFileSync(SQUARE_PATH).toString("base64")}`
const FIXTURES = new URL("../../../react/src/__tests__/fixtures/", import.meta.url)
const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(name, FIXTURES)))
const SQUARE_WOFF_DATA_URL = `data:font/woff;base64,${fixture("gpuix-test-square.woff").toString("base64")}`
const SQUARE_WOFF2_DATA_URL = `data:font/woff2;base64,${fixture("gpuix-test-square.woff2").toString("base64")}`
const NAMELESS_WOFF2_DATA_URL = `data:font/woff2;base64,${fixture("gpuix-test-nameless.woff2").toString("base64")}`
const NAMELESS_DATA_URL = `data:font/ttf;base64,${fs
  .readFileSync(fileURLToPath(new URL("../../../react/src/__tests__/fixtures/gpuix-test-nameless.ttf", import.meta.url)))
  .toString("base64")}`

const TEXT = { display: "inline-block", fontSize: 20, lineHeight: 1, color: "#000000" } as const

describe.skipIf(!hasNativeTestRenderer)("@font-face in a sheet", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot({ width: 800, height: 600 })
  })

  afterEach(() => {
    app.unmount()
  })

  const width = (testId: string) => app.renderer.getElementBounds(app.renderer.findByTestId(testId)!.id)!.width

  /** "AA" in `family`: two em of GpuixTestSquare, and less in any fallback. */
  const probe = (testId: string, family: string) => (
    <span testId={testId} style={{ ...TEXT, fontFamily: family }}>
      AA
    </span>
  )

  it("names a file by the family the rule gives it, over a file URL", () => {
    app.render(() => (
      <div>
        <style>{`@font-face { font-family: "Brand New"; src: url("${SQUARE_URL.href}") format("truetype") }`}</style>
        {probe("face", "Brand New")}
        {probe("plain", "No Such Brand")}
      </div>
    ))
    expect(width("face")).toBe(40)
    expect(width("plain")).not.toBe(40)
  })

  it("reads a data URL, a path, and the first source that loads", () => {
    app.render(() => (
      <div>
        <style>{`
          @font-face { font-family: Inline; src: url(${SQUARE_DATA_URL}) }
          @font-face { font-family: ByPath; src: url(${SQUARE_PATH}) }
          @font-face { font-family: Later; src: url(missing.woff2) format("woff2"), url(/no/such/file.ttf), url(${NAMELESS_DATA_URL}), url(${SQUARE_DATA_URL}) }
        `}</style>
        {probe("inline", "Inline")}
        {probe("path", "ByPath")}
        {probe("later", "Later")}
      </div>
    ))
    expect([width("inline"), width("path"), width("later")]).toEqual([40, 40, 40])
  })

  it("loads a WOFF and a WOFF2 file, from a data URL and from a path, under the family the rule gives it", () => {
    app.render(() => (
      <div>
        <style>{`
          @font-face { font-family: Woff; src: url(${SQUARE_WOFF_DATA_URL}) format("woff") }
          @font-face { font-family: Woff2; src: url(${SQUARE_WOFF2_DATA_URL}) format("woff2") }
          @font-face { font-family: Woff2Path; src: url("${new URL("gpuix-test-square.woff2", FIXTURES).href}") format("woff2"), url(${SQUARE_DATA_URL}) }
        `}</style>
        {probe("woff", "Woff")}
        {probe("woff2", "Woff2")}
        {probe("path", "Woff2Path")}
        {probe("plain", "No Such Brand")}
      </div>
    ))
    expect([width("woff"), width("woff2"), width("path")]).toEqual([40, 40, 40])
    expect(width("plain")).not.toBe(40)
  })

  it("skips a broken or nameless WOFF2 for the next source, and a rule with only those leaves the family alone", () => {
    app.render(() => (
      <div>
        <style>{`
          @font-face { font-family: Next; src: url(data:font/woff2;base64,d09GMgAAAAA=) format("woff2"), url(${NAMELESS_WOFF2_DATA_URL}) format("woff2"), url(${SQUARE_WOFF_DATA_URL}) format("woff") }
          @font-face { font-family: Only; src: url(data:font/woff2;base64,d09GMgAAAAA=) format("woff2"), url(${NAMELESS_WOFF2_DATA_URL}) format("woff2") }
        `}</style>
        {probe("next", "Next")}
        {probe("only", "Only")}
        {probe("fallback", "Another Missing Family")}
      </div>
    ))
    expect(width("next")).toBe(40)
    expect(width("only")).toBe(width("fallback"))
  })

  it("registers a WOFF2 file with registerFont, as the window's fonts option does", () => {
    app.renderer.registerFont(fixture("gpuix-test-square.woff2"))
    app.render(() => probe("registered", "GpuixTestSquare"))
    expect(width("registered")).toBe(40)
    expect(() => app.renderer.registerFont(fixture("gpuix-test-nameless.woff2"))).toThrow(/name/)
    expect(() => app.renderer.registerFont(fixture("gpuix-test-square.woff2").subarray(0, 60))).toThrow(/WOFF/)
  })

  it("lays out text again when the face arrives after the text", () => {
    const [sheet, setSheet] = createSignal("")
    app.render(() => (
      <div>
        <style>{sheet()}</style>
        {probe("late", "Arrives")}
      </div>
    ))
    const before = width("late")
    expect(before).not.toBe(40)
    app.flushSync(() => setSheet(`@font-face { font-family: Arrives; src: url(${SQUARE_DATA_URL}) }`))
    expect(width("late")).toBe(40)
    app.flushSync(() => setSheet(""))
    expect(width("late")).toBe(before)
  })

  it("registers a face under @media only while the query holds", () => {
    app.render(() => (
      <div>
        <style>{`@media (min-width: 1000px) { @font-face { font-family: Wide; src: url(${SQUARE_DATA_URL}) } }`}</style>
        {probe("wide", "Wide")}
      </div>
    ))
    const narrow = width("wide")
    expect(narrow).not.toBe(40)
    app.renderer.setWindowSize(1200, 600)
    app.renderer.flush()
    expect(width("wide")).toBe(40)
    app.renderer.setWindowSize(800, 600)
    app.renderer.flush()
    expect(width("wide")).toBe(narrow)
  })

  it("honours @supports and @layer around a face", () => {
    app.render(() => (
      <div>
        <style>{`
          @supports (display: grid) { @font-face { font-family: Supported; src: url(${SQUARE_DATA_URL}) } }
          @supports (nonsense: 1) { @font-face { font-family: Unsupported; src: url(${SQUARE_DATA_URL}) } }
          @layer base { @font-face { font-family: Layered; src: url(${SQUARE_DATA_URL}) } }
        `}</style>
        {probe("supported", "Supported")}
        {probe("unsupported", "Unsupported")}
        {probe("layered", "Layered")}
      </div>
    ))
    expect([width("supported"), width("layered")]).toEqual([40, 40])
    expect(width("unsupported")).not.toBe(40)
  })

  it("takes an installed font by local() and skips one that is not", () => {
    app.render(() => (
      <div>
        <style>{`
          @font-face { font-family: Mono; src: local(Missing Family Name), local(Menlo) }
          @font-face { font-family: Gone; src: local(Missing Family Name) }
        `}</style>
        {probe("mono", "Mono")}
        {probe("menlo", "Menlo")}
        {probe("gone", "Gone")}
        {probe("fallback", "Another Missing Family")}
      </div>
    ))
    expect(width("mono")).toBe(width("menlo"))
    expect(width("mono")).not.toBe(width("fallback"))
    expect(width("gone")).toBe(width("fallback"))
  })

  it("leaves a family alone when no source loads, and logs why once", () => {
    app.render(() => (
      <div>
        <style>{`@font-face { font-family: Broken; src: url(data:font/woff2;base64,d09GMgAAAAA=) format("truetype") }`}</style>
        {probe("broken", "Broken")}
        {probe("fallback", "Another Missing Family")}
      </div>
    ))
    expect(width("broken")).toBe(width("fallback"))
  })

  it("keeps the face for a family named in a list ahead of the system's", () => {
    app.render(() => (
      <div>
        <style>{`@font-face { font-family: Listed; src: url(${SQUARE_DATA_URL}) }`}</style>
        {probe("listed", "Listed, Helvetica, sans-serif")}
        {probe("quoted", "'Listed'")}
      </div>
    ))
    expect([width("listed"), width("quoted")]).toEqual([40, 40])
  })
})
