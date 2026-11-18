/// Where the marker of a list item is painted, against headless Chrome's (`fixtures/list-markers-oracle.*`, regenerate
/// with `list-markers-oracle.sh`; the page and the markup of the cases are `list-markers-oracle.html` and
/// `list-markers-cases.json`, read by both). Chrome gives scripts no box for a marker, so the oracle records the ink of
/// each: the pixels of the item's colour (the sheet of the cases colours an item by its depth and its text black) in the
/// rows of the item's first line and the columns before it. This test reads the same pixels off gpuix's screenshot, the
/// same way, and compares the device pixel boxes. The boxes of the items are compared as well, since a marker takes no
/// part in layout, and the dynamic cases (an item that comes and goes in an ordered list) are checked on the pixels of
/// the numbers.

import fs from "fs"
import path from "path"
import React from "react"
import { fileURLToPath } from "url"
import { afterAll, describe, expect, it } from "vitest"
import type { PublicInstance } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { readPixels, SHOTS_DIR, type Pixels } from "./test-utils.js"
import { styleOf } from "./oracle-html.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CASES: { css: string; cases: { name: string; html: string; h: number; style: string }[] } = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "list-markers-cases.json"), "utf8")
)

type Box = [number, number, number, number]

interface Item {
  box: Box
  text: Box
  color: string
  position: string
  ink: Box | null
  area: number
  textLeft: number | null
}

interface Oracle {
  scale: number
  cases: { name: string; items: Item[] }[]
}

const ORACLES: Record<1 | 2, Oracle> = {
  1: JSON.parse(fs.readFileSync(path.join(FIXTURES, "list-markers-oracle.json"), "utf8")),
  2: JSON.parse(fs.readFileSync(path.join(FIXTURES, "list-markers-oracle-x2.json"), "utf8")),
}

const THRESHOLD = 64
/** How far the ink of a marker may be off Chrome's in pixels, as a fraction of it: the ink of another digit is not. */
const AREA_TOLERANCE = 0.2
/** Device pixels an ink edge may be off by, by case. */
const TOLERANCE: Record<string, number> = {}

/** The tags and attributes of the cases, as elements. */
/** `ref` gets each `li` with its place in document order, which is not the order React attaches refs in (a child's before its parent's). */
function elementsOf(html: string, ref: (instance: PublicInstance | null, index: number) => void): React.ReactNode[] {
  const root: React.ReactNode[] = []
  const open: { tag: string; props: Record<string, unknown>; children: React.ReactNode[] }[] = []
  let key = 0
  let items = 0
  for (const token of html.split(/(<\/?[a-z]+(?: [a-z-]+(?:="[^"]*")?)*>)/).filter(Boolean)) {
    const opening = /^<([a-z]+)((?: [a-z-]+(?:="[^"]*")?)*)>$/.exec(token)
    if (opening) {
      const props: Record<string, unknown> = {}
      for (const attribute of opening[2]!.matchAll(/ ([a-z-]+)(?:="([^"]*)")?/g)) {
        const [, name, value] = attribute
        if (name === "style") props.style = styleOf(value!)
        else if (name === "class") props.className = value
        else if (name === "value" || name === "start") props[name] = Number(value)
        else props[name!] = value ?? true
      }
      if (opening[1] === "li") {
        const index = items++
        props.ref = (instance: PublicInstance | null) => ref(instance, index)
      }
      open.push({ tag: opening[1]!, props, children: [] })
    } else if (/^<\/[a-z]+>$/.test(token)) {
      const element = open.pop()!
      const built = React.createElement(element.tag, { key: key++, ...element.props }, ...element.children)
      ;(open.at(-1)?.children ?? root).push(built)
    } else {
      ;(open.at(-1)?.children ?? root).push(token)
    }
  }
  return root
}

/** The device pixel box of the ink of `color` in a region, as `list-markers-oracle.py` reads it. */
function inkBox(pixels: Pixels, region: Box, color: number[]): { box: Box | null; area: number } {
  const want = color.map((channel) => 255 - channel)
  const norm = Math.hypot(...want)
  let box: Box | null = null
  let area = 0
  for (let y = region[1]; y < region[3]; y++) {
    for (let x = region[0]; x < region[2]; x++) {
      const pixel = pixels.at(x, y)
      const got = [255 - pixel[0]!, 255 - pixel[1]!, 255 - pixel[2]!]
      if (Math.max(...got) <= THRESHOLD) continue
      const cosine = (got[0]! * want[0]! + got[1]! * want[1]! + got[2]! * want[2]!) / (Math.hypot(...got) * norm)
      if (cosine < 0.9) continue
      area++
      box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + 1), Math.max(box[3], y + 1)] : [x, y, x + 1, y + 1]
    }
  }
  return { box, area }
}

/** The first column with black ink of the rows of `region`, as `list-markers-oracle.py` reads it. */
function textLeft(pixels: Pixels, region: Box): number | null {
  for (let x = region[0]; x < region[2]; x++) {
    for (let y = region[1]; y < region[3]; y++) {
      const pixel = pixels.at(x, y).slice(0, 3)
      if (255 - Math.min(...pixel) > THRESHOLD && Math.max(...pixel) - Math.min(...pixel) < 40) return x
    }
  }
  return null
}

function colorOf(css: string): number[] {
  return [...css.matchAll(/\d+/g)].slice(0, 3).map((match) => Number(match[0]))
}

/** The region of the page the oracle looks for the marker of `item` in, in device pixels of a band at the origin. */
function regionOf(item: Item, scale: number): Box {
  const right = item.position === "inside" ? item.text[0] : item.box[0]
  return [
    Math.round(Math.max(0, item.box[0] - 90) * scale),
    Math.round(item.text[1] * scale),
    Math.round(right * scale),
    Math.round((item.text[1] + item.text[3]) * scale),
  ]
}

interface Painted {
  boxes: Box[]
  inks: { box: Box | null; area: number }[]
  textLefts: (number | null)[]
}

function paint(testCase: { html: string; h: number; style: string }, items: Item[], scale: 1 | 2, name: string): Painted {
  const root = createTestRoot({ width: 740, height: testCase.h, scaleFactor: scale })
  try {
    const refs: PublicInstance[] = []
    root.render(
      <div
        style={{
          width: 640,
          height: testCase.h,
          boxSizing: "border-box",
          paddingLeft: 100,
          backgroundColor: "#ffffff",
          color: "#000000",
          fontSize: 16,
          lineHeight: "24px",
          fontFamily: "Helvetica",
          overflow: "hidden",
          ...styleOf(testCase.style),
        }}
      >
        <style>{CASES.css}</style>
        {elementsOf(testCase.html, (instance, index) => {
          if (instance) refs[index] = instance
        })}
      </div>
    )
    root.renderer.dispatchNativeEvents()
    expect(root.renderer.getA11yTree().frame?.scale_factor, "the window has the scale asked for").toBe(scale)
    const file = path.join(SHOTS_DIR, `list-markers-x${scale}-${name.replaceAll(/[^a-z0-9]+/gi, "-")}.png`)
    root.renderer.captureScreenshot(file)
    const pixels = readPixels(file)
    const boxes = refs.map((instance) => {
      const box = instance.getBoundingClientRect()
      return [box.x, box.y, box.width, box.height] as Box
    })
    const inks = items.map((item) => inkBox(pixels, regionOf(item, scale), colorOf(item.color)))
    const textLefts = items.map((item) => {
      const [x, y, width] = [item.box[0], item.text[1], item.box[2]]
      return textLeft(pixels, [Math.round(x * scale), Math.round(y * scale), Math.round((x + width) * scale), Math.round((y + item.text[3]) * scale)])
    })
    return { boxes, inks, textLefts }
  } finally {
    root.unmount()
  }
}

describeNative("the marker of a list item, against Chrome", () => {
  for (const scale of [1, 2] as const) {
    const oracle = ORACLES[scale]
    describe(`at scale ${scale}`, () => {
      const worst: Record<string, number> = {}
      afterAll(() => console.log(`list markers at scale ${scale}, worst ink edge off by case (device px):`, JSON.stringify(worst)))
      for (const [index, testCase] of CASES.cases.entries()) {
        it(testCase.name, () => {
          const expected = oracle.cases[index]!
          expect(expected.name).toBe(testCase.name)
          const painted = paint(testCase, expected.items, scale, testCase.name)
          expect(painted.boxes.length, "an li for each li").toBe(expected.items.length)
          const problems: string[] = []
          expected.items.forEach((item, at) => {
            // A marker takes no part in layout: the items are where Chrome has them.
            const box = painted.boxes[at]!
            const boxOff = Math.max(...item.box.map((edge, side) => Math.abs(edge - box[side]!)))
            if (boxOff > 0.51 / scale) problems.push(`item ${at} box ${JSON.stringify(box)} against Chrome's ${JSON.stringify(item.box)}`)
            const { box: ink, area } = painted.inks[at]!
            const off = item.ink && ink ? Math.max(...item.ink.map((edge, side) => Math.abs(edge - ink[side]!))) : item.ink || ink ? Infinity : 0
            if (process.env.LIST_MARKERS_REPORT) {
              fs.appendFileSync(
                process.env.LIST_MARKERS_REPORT,
                `${scale} ${testCase.name} #${at} area ${area} ${item.area} ghia ${JSON.stringify(ink)} chrome ${JSON.stringify(item.ink)} d ${JSON.stringify(item.ink && ink ? item.ink.map((edge, side) => ink[side]! - edge) : null)} box ${boxOff}\n`
              )
            }
            const left = painted.textLefts[at]
            if (left !== item.textLeft) problems.push(`item ${at} text starts at column ${left}, Chrome's at ${item.textLeft}`)
            worst[testCase.name] = Math.max(worst[testCase.name] ?? 0, off)
            if (item.ink && Math.abs(area - item.area) > AREA_TOLERANCE * item.area) {
              problems.push(`item ${at} paints ${area} pixels of ink, Chrome ${item.area}`)
            }
            if (off > (TOLERANCE[testCase.name] ?? 0)) problems.push(`item ${at} ink ${JSON.stringify(ink)} against Chrome's ${JSON.stringify(item.ink)}`)
          })
          expect(problems).toEqual([])
        })
      }
    })
  }
})

