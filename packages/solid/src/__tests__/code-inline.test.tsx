/// The Solid half of the React test of the same name: `<code>`, `<kbd>`, `<samp>`, `<tt>` and `<pre>` against headless
/// Chrome (`packages/react/src/__tests__/fixtures/code-inline-oracle*.json`). The page's markup is built with the DOM
/// API, the way a library does, and the computed font sizes and the boxes are read back and compared.

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, it } from "vitest"
import { document, getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../react/src/__tests__/fixtures")

type Rect = [number, number, number, number]

interface Oracle {
  rects: Record<string, Rect>
  fontSizes: Record<string, string>
}

const SCALES = [1, 2] as const
type Scale = (typeof SCALES)[number]

const ORACLE: Record<Scale, Oracle> = {
  1: JSON.parse(fs.readFileSync(path.join(FIXTURES, "code-inline-oracle.json"), "utf8")),
  2: JSON.parse(fs.readFileSync(path.join(FIXTURES, "code-inline-oracle-x2.json"), "utf8")),
}

const PAGE = fs.readFileSync(path.join(FIXTURES, "code-inline-oracle.html"), "utf8")
const MARKUP = PAGE.slice(PAGE.indexOf("<body>") + "<body>".length, PAGE.indexOf("<script>"))

/** What Ghia does not have: `font-size: larger` and the other keywords (docs/fork/deviations.md, HTML tags). */
const UNSUPPORTED = new Set(["parent-larger"])

/** A family list nothing in it is installed for: Chrome draws it in its standard font (Times) and Ghia in GPUI's fallback face, which the font size does not depend on (docs/fork/deviations.md, font family lists). Only its font size is compared. */
const FALLBACK_FONT = new Set(["ui-monospace", "monospace-quoted"])

/** The elements the markup stands for, appended to `parent`, by their `data-id`. */
function build(html: string, parent: Element, elements: Map<string, Element>) {
  const open: Element[] = [parent]
  for (const token of html.split(/(<\/?[a-z]+(?: [a-z-]+(?:="[^"]*")?)*>)/).filter(Boolean)) {
    const opening = /^<([a-z]+)((?: [a-z-]+(?:="[^"]*")?)*)>$/.exec(token)
    if (opening) {
      const tag = opening[1]!
      const element = document.createElement(tag) as unknown as Element
      let style = tag === "p" || tag === "pre" ? "margin: 0;" : ""
      for (const attribute of opening[2]!.matchAll(/ ([a-z-]+)(?:="([^"]*)")?/g)) {
        const [, name, value] = attribute
        if (name === "style") style += value
        else if (name === "class" && value === "base") style += "display: inline-block; width: 0; height: 0;"
        else if (name === "data-id") elements.set(value!, element)
      }
      if (style) element.setAttribute("style", style)
      open.at(-1)!.appendChild(element)
      open.push(element)
    } else if (/^<\/[a-z]+>$/.test(token)) {
      open.pop()
    } else if (open.length > 1) {
      open.at(-1)!.appendChild(document.createTextNode(token) as unknown as Node)
    }
  }
}

async function render(scale: Scale) {
  const app = createTestRoot({ width: 1280, height: 800, scaleFactor: scale })
  let page!: Element
  app.render(() => <div ref={(element) => (page = element as unknown as Element)} style={{ width: 1280, "font-family": "Helvetica" }} />)
  const elements = new Map<string, Element>()
  build(MARKUP, page, elements)
  // What code builds reaches native in a microtask.
  await Promise.resolve()
  await Promise.resolve()
  app.renderer.flush()
  app.renderer.dispatchNativeEvents()
  const element = (id: string) => {
    const found = elements.get(id)
    expect(found, `no element ${id}`).toBeDefined()
    return found!
  }
  const rect = (id: string): Rect => {
    const box = element(id).getBoundingClientRect()
    const origin = element(id.split(".")[0]!).getBoundingClientRect()
    return [box.x - origin.x, box.y - origin.y, box.width, box.height]
  }
  const fontSize = (id: string) => parseFloat(getComputedStyle(element(id)).getPropertyValue("font-size"))
  return { app, rect, fontSize }
}

const ids = (oracle: Oracle) => Object.keys(oracle.fontSizes).filter((id) => !UNSUPPORTED.has(id.split(".")[0]!) && id.includes("."))

describe.skipIf(!hasNativeTestRenderer)("monospace elements in Solid, against Chrome", () => {
  it("computes the font size Chrome does", async () => {
    const page = await render(1)
    try {
      for (const id of ids(ORACLE[1])) {
        expect(page.fontSize(id), `${id}: ${ORACLE[1].fontSizes[id]}`).toBeCloseTo(parseFloat(ORACLE[1].fontSizes[id]!), 2)
      }
    } finally {
      page.app.unmount()
    }
  })

  for (const scale of SCALES) {
    it(`lays out the boxes and the baseline of the line as Chrome does (scale ${scale})`, async () => {
      const page = await render(scale)
      try {
        const failures: string[] = []
        for (const id of ids(ORACLE[scale])) {
          if (FALLBACK_FONT.has(id.split(".")[0]!)) continue
          const compared = id.endsWith(".p") ? [1, 3] : [0, 1, 2, 3]
          const expected = ORACLE[scale].rects[id]!
          const actual = page.rect(id)
          for (const index of compared) {
            if (Math.abs(actual[index]! - expected[index]!) > 0.51 / scale) {
              failures.push(`${id} ${["x", "y", "w", "h"][index]}: ${actual[index]} != ${expected[index]}`)
            }
          }
        }
        expect(failures).toEqual([])
      } finally {
        page.app.unmount()
      }
    })
  }
})
