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
import { defineKeyframes } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { styleOf } from "./oracle-html.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures")

type Rect = [number, number, number, number]

interface Scenes {
  transitionRest: number
  transitionStart: number
  transitionUp: { mid: number; end: number }
  transitionBackStart: number
  transitionDown: { mid: number; end: number }
  keyframesStart: number
  keyframes: { mid: number; end: number }
  /** The computed `font-size` and the width of the element, before and after it took focus. */
  focusBefore: [number, number]
  focusAfter: [number, number]
  focused: boolean
}

interface Oracle {
  rects: Record<string, Rect>
  fontSizes: Record<string, string>
  scenes: Scenes
}

const SCALES = [1, 2] as const
type Scale = (typeof SCALES)[number]

const ORACLE: Record<Scale, Oracle> = {
  1: JSON.parse(fs.readFileSync(path.join(FIXTURES, "code-inline-oracle.json"), "utf8")),
  2: JSON.parse(fs.readFileSync(path.join(FIXTURES, "code-inline-oracle-x2.json"), "utf8")),
}

const PAGE = fs.readFileSync(path.join(FIXTURES, "code-inline-oracle.html"), "utf8")
const MARKUP = PAGE.slice(PAGE.indexOf("<body>") + "<body>".length, PAGE.indexOf("<!--scenes-->"))

/** What Ghia does not have: `font-size: larger` and the other keywords ([deviations.md](docs/fork/deviations.md#html-tags)). */
const UNSUPPORTED = new Set(["parent-larger"])

/** A family list nothing in it is installed for: Chrome draws it in its standard font (Times) and Ghia in GPUI's fallback face, which the font size does not depend on (docs/fork/deviations.md, font family lists). Only its font size is compared. */
const FALLBACK_FONT = new Set(["ui-monospace", "monospace-quoted"])

/** An inline box with nothing in it but an atomic inline: Ghia reports the line's height for it, where Chrome reports the content area of its own font (a `small` around a lone `inline-block` is 15px tall in Chrome and 18 here, with or without a `code` in it). Only its font size is compared. */
const ATOMIC_ONLY = new Set(["atomic-small-code.small"])

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
        const name = attribute[1]
        const value = attribute[2]
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
          if (FALLBACK_FONT.has(id.split(".")[0]!) || ATOMIC_ONLY.has(id)) continue
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

defineKeyframes("code-inline-grow", { to: { fontSize: "2em" } })

/** The page's scenes: a `code` whose size a transition, a keyframe animation and a `:focus` rule move. Animations are read at 150 ms of their 300 and finished. */
describeNative("the size of a monospace element in motion, against Chrome", () => {
  const sizeOf = (instance: PublicInstance | undefined) => {
    expect(instance, "not rendered").toBeDefined()
    return parseFloat(getComputedStyle(instance as unknown as Element).getPropertyValue("font-size"))
  }

  /** Renders `node` in a paused window of device scale `scale`. */
  function mount(scale: Scale, node: (ref: (instance: PublicInstance | null) => void, on: boolean) => React.ReactNode) {
    const root = createTestRoot()
    root.renderer.setWindowScaleFactor(scale)
    root.renderer.clockPause()
    let instance: PublicInstance | undefined
    const ref = (value: PublicInstance | null) => {
      if (value) instance = value
    }
    const show = (on: boolean) => {
      root.render(
        <div style={{ width: 1280, fontFamily: "Helvetica" }}>
          <p style={{ margin: 0 }}>{node(ref, on)}</p>
        </div>
      )
      root.renderer.dispatchNativeEvents()
    }
    const fastForward = (ms: number) => {
      root.renderer.clockFastForward(ms)
      root.renderer.dispatchNativeEvents()
    }
    return { ...root, show, fastForward, size: () => sizeOf(instance), instance: () => instance! }
  }

  for (const scale of SCALES) {
    const scenes = ORACLE[scale].scenes

    it(`transitions the size of a code between the sizes it computes to, with no jump (scale ${scale})`, () => {
      const page = mount(scale, (ref, on) => (
        <code ref={ref} style={{ fontSize: on ? "1.5em" : "1em", transition: "font-size .3s linear" }}>
          b
        </code>
      ))
      try {
        page.show(false)
        expect(page.size()).toBeCloseTo(scenes.transitionRest, 2)
        page.show(true)
        expect(page.size()).toBeCloseTo(scenes.transitionStart, 2)
        page.fastForward(150)
        expect(page.size()).toBeCloseTo(scenes.transitionUp.mid, 2)
        page.fastForward(300)
        expect(page.size()).toBeCloseTo(scenes.transitionUp.end, 2)
        page.show(false)
        expect(page.size()).toBeCloseTo(scenes.transitionBackStart, 2)
        page.fastForward(150)
        expect(page.size()).toBeCloseTo(scenes.transitionDown.mid, 2)
        page.fastForward(300)
        expect(page.size()).toBeCloseTo(scenes.transitionDown.end, 2)
      } finally {
        page.unmount()
      }
    })

    it(`grows a code to the size a keyframe resolves in its parent's font, and holds it (scale ${scale})`, () => {
      const page = mount(scale, (ref) => (
        <code ref={ref} style={{ animation: "code-inline-grow .3s linear forwards" }}>
          b
        </code>
      ))
      try {
        page.show(true)
        expect(page.size()).toBeCloseTo(scenes.keyframesStart, 2)
        page.fastForward(150)
        expect(page.size()).toBeCloseTo(scenes.keyframes.mid, 2)
        page.fastForward(300)
        expect(page.size()).toBeCloseTo(scenes.keyframes.end, 2)
      } finally {
        page.unmount()
      }
    })

    it(`draws a code at the size its focus rule computes to (scale ${scale})`, () => {
      expect(scenes.focused).toBe(true)
      const page = mount(scale, (ref) => (
        <code ref={ref} tabIndex={0} style={{ display: "inline-block", focus: { fontSize: "1em" } }}>
          bbbbbbbbbb
        </code>
      ))
      try {
        page.show(true)
        const width = () => page.instance().getBoundingClientRect().width
        expect(page.size()).toBeCloseTo(scenes.focusBefore[0], 2)
        expect(width()).toBeCloseTo(scenes.focusBefore[1], 0)
        ;(page.instance() as unknown as HTMLElement).focus()
        page.renderer.flush()
        page.renderer.dispatchNativeEvents()
        expect(page.size()).toBeCloseTo(scenes.focusAfter[0], 2)
        expect(width()).toBeCloseTo(scenes.focusAfter[1], 0)
      } finally {
        page.unmount()
      }
    })
  }
})
