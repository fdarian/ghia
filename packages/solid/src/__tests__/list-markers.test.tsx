/// The Solid half of the React test of the same name: where the marker of a list item is painted, against headless
/// Chrome's (`packages/react/src/__tests__/fixtures/list-markers-oracle*.json`, cases in `list-markers-cases.json`). The
/// markup is built with the DOM API, the way a library does, and the ink of each marker is read off the screenshot as the
/// oracle reads it off Chrome's. The dynamic cases are in the React test.

import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { afterAll, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { readLogicalPixels } from "./pixels.js"

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../react/src/__tests__/fixtures")
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

const ORACLES: Record<1 | 2, { cases: { name: string; items: Item[] }[] }> = {
  1: JSON.parse(fs.readFileSync(path.join(FIXTURES, "list-markers-oracle.json"), "utf8")),
  2: JSON.parse(fs.readFileSync(path.join(FIXTURES, "list-markers-oracle-x2.json"), "utf8")),
}

const THRESHOLD = 64
const AREA_TOLERANCE = 0.2
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "gpuix-solid-list-markers-"))
afterAll(() => fs.rmSync(shots, { recursive: true, force: true }))

/** The elements the markup of a case stands for, appended to `parent`; the `li`s are collected in document order. */
function build(html: string, parent: Element, items: Element[]) {
  const open: Element[] = [parent]
  for (const token of html.split(/(<\/?[a-z]+(?: [a-z-]+(?:="[^"]*")?)*>)/).filter(Boolean)) {
    const opening = /^<([a-z]+)((?: [a-z-]+(?:="[^"]*")?)*)>$/.exec(token)
    if (opening) {
      const element = document.createElement(opening[1]!) as unknown as Element
      for (const attribute of opening[2]!.matchAll(/ ([a-z-]+)(?:="([^"]*)")?/g)) {
        element.setAttribute(attribute[1]!, attribute[2] ?? "")
      }
      if (opening[1] === "li") items.push(element)
      open.at(-1)!.appendChild(element)
      open.push(element)
    } else if (/^<\/[a-z]+>$/.test(token)) {
      open.pop()
    } else {
      open.at(-1)!.appendChild(document.createTextNode(token) as unknown as Node)
    }
  }
}

function colorOf(css: string): number[] {
  return [...css.matchAll(/\d+/g)].slice(0, 3).map((match) => Number(match[0]))
}

describe.skipIf(!hasNativeTestRenderer)("the marker of a list item in Solid, against Chrome", () => {
  for (const scale of [1, 2] as const) {
    describe(`at scale ${scale}`, () => {
      for (const [index, testCase] of CASES.cases.entries()) {
        it(testCase.name, async () => {
          const expected = ORACLES[scale].cases[index]!
          const app = createTestRoot({ width: 740, height: testCase.h, scaleFactor: scale })
          try {
            let band!: Element
            app.render(() => (
              <div
                ref={(element) => (band = element as unknown as Element)}
                style={{
                  width: 640,
                  height: testCase.h,
                  "box-sizing": "border-box",
                  "padding-left": 100,
                  "background-color": "#ffffff",
                  color: "#000000",
                  "font-size": 16,
                  "line-height": "24px",
                  "font-family": "Helvetica",
                  overflow: "hidden",
                  ...Object.fromEntries(testCase.style.split(";").filter(Boolean).map((declaration) => declaration.split(":") as [string, string])),
                }}
              />
            ))
            const style = document.createElement("style") as unknown as Element
            style.textContent = CASES.css
            band.appendChild(style)
            const items: Element[] = []
            build(testCase.html, band, items)
            // What code builds reaches native in a microtask.
            await Promise.resolve()
            await Promise.resolve()
            app.renderer.flush()
            app.renderer.dispatchNativeEvents()
            const file = path.join(shots, `${scale}-${index}.png`)
            app.renderer.captureScreenshot(file)
            const pixels = readLogicalPixels(file, app.renderer)
            const at = (x: number, y: number) => pixels.at((x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5)
            expect(items.length).toBe(expected.items.length)
            const problems: string[] = []
            expected.items.forEach((item, position) => {
              const rect = items[position]!.getBoundingClientRect()
              const box = [rect.x, rect.y, rect.width, rect.height]
              if (Math.max(...item.box.map((edge, side) => Math.abs(edge - box[side]!))) > 0.51 / scale) {
                problems.push(`item ${position} box ${JSON.stringify(box)} against Chrome's ${JSON.stringify(item.box)}`)
              }
              const right = item.position === "inside" ? item.text[0] : item.box[0]
              const region = [
                Math.round(Math.max(0, item.box[0] - 90) * scale),
                Math.round(item.text[1] * scale),
                Math.round(right * scale),
                Math.round((item.text[1] + item.text[3]) * scale),
              ] as Box
              const want = colorOf(item.color).map((channel) => 255 - channel)
              const norm = Math.hypot(...want)
              let ink: Box | null = null
              let area = 0
              for (let y = region[1]; y < region[3]; y++) {
                for (let x = region[0]; x < region[2]; x++) {
                  const pixel = at(x, y)
                  const got = [255 - pixel[0], 255 - pixel[1], 255 - pixel[2]]
                  if (Math.max(...got) <= THRESHOLD) continue
                  if ((got[0]! * want[0]! + got[1]! * want[1]! + got[2]! * want[2]!) / (Math.hypot(...got) * norm) < 0.9) continue
                  area++
                  ink = ink ? [Math.min(ink[0], x), Math.min(ink[1], y), Math.max(ink[2], x + 1), Math.max(ink[3], y + 1)] : [x, y, x + 1, y + 1]
                }
              }
              if (JSON.stringify(ink) !== JSON.stringify(item.ink)) {
                problems.push(`item ${position} ink ${JSON.stringify(ink)} against Chrome's ${JSON.stringify(item.ink)}`)
              } else if (item.ink && Math.abs(area - item.area) > AREA_TOLERANCE * item.area) {
                problems.push(`item ${position} paints ${area} pixels of ink, Chrome ${item.area}`)
              }
              let left: number | null = null
              const rows = [Math.round(item.text[1] * scale), Math.round((item.text[1] + item.text[3]) * scale)]
              for (let x = Math.round(item.box[0] * scale); x < Math.round((item.box[0] + item.box[2]) * scale) && left === null; x++) {
                for (let y = rows[0]!; y < rows[1]!; y++) {
                  const pixel = at(x, y)
                  if (255 - Math.min(pixel[0], pixel[1], pixel[2]) > THRESHOLD && Math.max(pixel[0], pixel[1], pixel[2]) - Math.min(pixel[0], pixel[1], pixel[2]) < 40) {
                    left = x
                    break
                  }
                }
              }
              if (left !== item.textLeft) problems.push(`item ${position} text starts at column ${left}, Chrome's at ${item.textLeft}`)
            })
            expect(problems).toEqual([])
          } finally {
            app.unmount()
          }
        })
      }
    })
  }
})

describe.skipIf(!hasNativeTestRenderer)("the members that number a list in Solid", () => {
  it("`li.value`, `ol.start` and `ol.reversed` reflect their attributes as the DOM's do", () => {
    const app = createTestRoot({ width: 300, height: 260 })
    try {
      let ol!: HTMLOListElement
      let li!: HTMLLIElement
      app.render(() => (
        <ol ref={(element) => (ol = element as unknown as HTMLOListElement)}>
          <li ref={(element) => (li = element as unknown as HTMLLIElement)}>a</li>
        </ol>
      ))
      expect([ol.start, ol.reversed, li.value]).toEqual([1, false, 0])
      ol.start = 7
      ol.reversed = true
      li.value = 3.9
      expect([ol.getAttribute("start"), ol.getAttribute("reversed"), li.getAttribute("value")]).toEqual(["7", "", "3"])
      expect([ol.start, ol.reversed, li.value]).toEqual([7, true, 3])
      ol.reversed = false
      expect([ol.getAttribute("reversed"), ol.reversed]).toEqual([null, false])
    } finally {
      app.unmount()
    }
  })
})

describe.skipIf(!hasNativeTestRenderer)("an inside marker follows the list in Solid", () => {
  /** An inside list of `texts` drawn by code, after `change` has run on it; the screenshot's bytes. */
  async function drawn(texts: string[], style: Record<string, string>, change?: (list: Element, items: Element[]) => void): Promise<Buffer> {
    const app = createTestRoot({ width: 300, height: 300 })
    try {
      let host!: Element
      app.render(() => (
        <div
          ref={(element) => (host = element as unknown as Element)}
          style={{ width: 300, height: 300, "background-color": "#ffffff", color: "#000000", "font-size": 16, "line-height": "24px", "font-family": "Helvetica" }}
        />
      ))
      const list = document.createElement("ol") as unknown as HTMLElement
      Object.assign(list.style, { color: "#ff0000", "list-style-position": "inside", ...style })
      const items = texts.map((text) => {
        const item = document.createElement("li") as unknown as Element
        const span = document.createElement("span") as unknown as HTMLElement
        span.style.color = "#000000"
        span.textContent = text
        item.appendChild(span as unknown as Node)
        list.appendChild(item as unknown as Node)
        return item
      })
      host.appendChild(list as unknown as Node)
      await Promise.resolve()
      await Promise.resolve()
      app.renderer.flush()
      app.renderer.dispatchNativeEvents()
      if (change) {
        change(list as unknown as Element, items)
        await Promise.resolve()
        await Promise.resolve()
        app.renderer.flush()
        app.renderer.dispatchNativeEvents()
      }
      const file = path.join(shots, `inside-${Math.random().toString(36).slice(2)}.png`)
      app.renderer.captureScreenshot(file)
      return fs.readFileSync(file)
    } finally {
      app.unmount()
    }
  }

  it("an item that becomes the tenth moves its text for the wider number", async () => {
    const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"]
    const fresh = await drawn([...nine.slice(0, 8), "x", "i"], {})
    const changed = await drawn(nine, {}, (list, items) => {
      const item = document.createElement("li") as unknown as Element
      const span = document.createElement("span") as unknown as HTMLElement
      span.style.color = "#000000"
      span.textContent = "x"
      item.appendChild(span as unknown as Node)
      list.insertBefore(item as unknown as Node, items[8] as unknown as Node)
    })
    expect(changed.equals(fresh)).toBe(true)
  })

  it("an inside list that changes from discs to numbers moves its text", async () => {
    const texts = ["a", "b", "c"]
    const fresh = await drawn(texts, { "list-style-type": "decimal" })
    const changed = await drawn(texts, { "list-style-type": "disc" }, (list) => {
      ;(list as unknown as HTMLElement).style.setProperty("list-style-type", "decimal")
    })
    expect(changed.equals(fresh)).toBe(true)
  })
})
