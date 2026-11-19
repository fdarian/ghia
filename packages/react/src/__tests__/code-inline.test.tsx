/// `<code>`, `<kbd>`, `<samp>`, `<tt>` and `<pre>` against headless Chrome: their user agent style is `font-family:
/// monospace`, and Chrome draws the generic `monospace` at 13px where the text around it is 16px, by scaling a font
/// size that is not an absolute length when the family becomes the generic `monospace` alone (and back when it stops
/// being). `fixtures/code-inline-oracle.html` is the page (the test renders its markup) and
/// `fixtures/code-inline-oracle.json` what Chrome reports for it, `-x2` the same on a display of scale 2; regenerate
/// with `fixtures/dsf-oracle.sh code-inline`. `fontSizes` is the computed `font-size` of each element and `rects`
/// `[x, y, width, height]` relative to the box of the case, where `.base` is a zero-size inline-block on the baseline
/// of the line, so its `y` is the baseline. The text is the real Menlo and Helvetica, so the boxes follow the machine's
/// fonts; the font sizes do not.

import fs from "fs"
import path from "path"
import React from "react"
import { fileURLToPath } from "url"
import { describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import type { PublicInstance } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { styleOf } from "./oracle-html.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures")

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

/** What Ghia does not have: `font-size: larger` and the other keywords ([deviations.md](docs/fork/deviations.md#html-tags)). */
const UNSUPPORTED = new Set(["parent-larger"])

/** The oracle's markup as elements; `ref` gets each one that has a `data-id`. The cases are its `data-case` boxes. */
function elementsOf(html: string, ref: (id: string, instance: PublicInstance | null) => void): React.ReactNode[] {
  const root: React.ReactNode[] = []
  const open: { tag: string; props: Record<string, unknown>; children: React.ReactNode[] }[] = []
  let key = 0
  for (const token of html.split(/(<\/?[a-z]+(?: [a-z-]+(?:="[^"]*")?)*>)/).filter(Boolean)) {
    const opening = /^<([a-z]+)((?: [a-z-]+(?:="[^"]*")?)*)>$/.exec(token)
    if (opening) {
      const tag = opening[1]!
      let style: Record<string, string | number> = tag === "p" || tag === "pre" ? { margin: 0 } : {}
      const props: Record<string, unknown> = {}
      for (const attribute of opening[2]!.matchAll(/ ([a-z-]+)(?:="([^"]*)")?/g)) {
        const [, name, value] = attribute
        if (name === "style") style = { ...style, ...styleOf(value!) }
        else if (name === "class" && value === "base") style = { ...style, display: "inline-block", width: 0, height: 0 }
        else if (name === "data-id") props.ref = (instance: PublicInstance | null) => ref(value!, instance)
      }
      open.push({ tag, props: { ...props, style }, children: [] })
    } else if (/^<\/[a-z]+>$/.test(token)) {
      const element = open.pop()!
      const built = React.createElement(element.tag, { key: key++, ...element.props }, ...element.children)
      ;(open.at(-1)?.children ?? root).push(built)
    } else if (open.length > 0) {
      open.at(-1)!.children.push(token)
    }
  }
  return root
}

function render(scale: Scale) {
  const root = createTestRoot()
  root.renderer.setWindowScaleFactor(scale)
  const refs = new Map<string, PublicInstance>()
  root.render(
    <div style={{ width: 1280, fontFamily: "Helvetica" }}>
      {elementsOf(MARKUP, (id, instance) => {
        if (instance) refs.set(id, instance)
      })}
    </div>
  )
  root.renderer.dispatchNativeEvents()
  const element = (id: string) => {
    const found = refs.get(id)
    expect(found, `no element ${id}`).toBeDefined()
    return found!
  }
  const rect = (id: string): Rect => {
    const box = element(id).getBoundingClientRect()
    const origin = element(id.split(".")[0]!).getBoundingClientRect()
    return [box.x - origin.x, box.y - origin.y, box.width, box.height]
  }
  const fontSize = (id: string): number => parseFloat(getComputedStyle(element(id) as unknown as Element).getPropertyValue("font-size"))
  return { ...root, rect, fontSize }
}

const caseOf = (id: string) => id.split(".")[0]!

const ids = (oracle: Oracle) => Object.keys(oracle.fontSizes).filter((id) => !UNSUPPORTED.has(caseOf(id)) && id.includes("."))

describeNative("monospace elements against Chrome", () => {
  it("computes the font size Chrome does", () => {
    const page = render(1)
    try {
      for (const id of ids(ORACLE[1])) {
        expect(page.fontSize(id), `${id}: ${ORACLE[1].fontSizes[id]}`).toBeCloseTo(parseFloat(ORACLE[1].fontSizes[id]!), 2)
      }
    } finally {
      page.unmount()
    }
  })

  for (const scale of SCALES) {
    it(`lays out the boxes and the baseline of the line as Chrome does (scale ${scale})`, () => {
      const page = render(scale)
      try {
        const failures: string[] = []
        for (const id of ids(ORACLE[scale])) {
          // The block's own width is the window's in Chrome and the 1280px of the page here.
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
        page.unmount()
      }
    })
  }
})
