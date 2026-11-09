/**
 * A plain subtree can be drawn by one element that owns its nodes (`render/`, `setDirectPaint`) where each host would be a `Div`.
 * Each scene is mounted in a window of its own with the switch off and on and taken through commits that move text, style and size,
 * with a frame drawn again after each (which a retained root replays), and the pictures, the automation trees (with the boxes a
 * direct node records as a `Div` does) and the painted text of every step are compared. The scenes hold roots that are direct
 * and, in the last, one that is not, which must be drawn as it always was. The scenes with a pointer have it cross the roots
 * and click them, and compare what the page hears: the box of the target and of each element of the path of the event. The
 * rows of a mailbox (a positioned root with a click listener and a hover style, absolute children, one-line texts) and boxes
 * that overlap their siblings (the z order of a positioned descendant, and where it is hit) are scenes of their own. The last
 * test has the pointer cross the nodes of a root that hold a cursor and `pointer-events`, and compares the target, the path
 * of the event and the cursor. The `user-select` scene drags a selection from each card (none, text, and a descendant that
 * reopens or closes it) and copies it, so the start regions and the selectable text must come out as the `Div` build's.
 * The `overflow-hidden` scene scrolls boxes that clip (one inside another, and a text that clips with an ellipsis) from script
 * and reads what they report back, with steps that leave the offset alone and replay the boxes. The `scroll-anchoring` scene has
 * rows inserted and removed above the first row in view of an `overflow: auto` scroller, whose rows are direct (in a wrapper,
 * which is one root that holds them, and as roots of their own): the scroller must anchor to the row it did with `Div`s.
 * The rows of a `<virtual-list>` are stacking roots (their positioned descendants are lifted to the row, and nothing leaves it), and a
 * row is a direct root all the same: the `list-*` scenes have the bench's rows in a list, rows whose absolute children overlap the next
 * row (and one with a `z-index` of its own, below and above its content), the pointer crossing them and a scroll that mounts others.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { HostElement } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Scene = {
  name: string
  steps: number
  width?: number
  height?: number
  view: (step: Accessor<number>) => JSX.Element
  /** The roots the page has that are drawn direct. */
  directRoots: number
  /** The nodes they hold, at least. */
  directNodes?: number
  /** The pointer is on the page: what it heard in each frame is compared, and some frame heard it. */
  hears?: boolean
  /** What the pointer does after the step is drawn. */
  act?: (renderer: ReturnType<typeof createTestRoot>["renderer"], step: number) => void
}

const CARD = {
  margin: "3px 6px",
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid #335577",
  backgroundColor: "#eef3f8",
  color: "#223344",
  fontSize: 14,
  lineHeight: "18px",
}

/** What the page heard of the pointer since the last frame: the boxes of the target and of the path of the event. */
const heard: string[] = []
const box = (target: unknown) => {
  const { x, y, width, height } = (target as HostElement).getBoundingClientRect()
  return `${x},${y} ${width}x${height}`
}
const hear = (label: string) => (event: { target: unknown; composedPath: () => unknown[] }) =>
  void heard.push(`${label} ${box(event.target)} < ${event.composedPath().map(box).join(" < ")}`)

/** The hosts of a scene that the pointer does not reach but a script does (`scrollTop`). */
const hosts: Record<string, HostElement> = {}
const named = (name: string) => (host: HostElement) => void (hosts[name] = host)
const scrollState = (name: string) => {
  const host = hosts[name]
  return `${name} ${host.scrollLeft},${host.scrollTop} of ${host.scrollWidth}x${host.scrollHeight} in ${host.clientWidth}x${host.clientHeight}`
}

const ROW_HEIGHT = 72
const ONE_LINE = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const
const AVATAR_COLORS = ["#F87171", "#FB923C", "#FBBF24", "#34D399", "#22D3EE", "#60A5FA", "#A78BFA", "#F472B6"]
const MESSAGES = [
  { from: "Ada Lovelace", time: "9:41", subject: "Notes on the Analytical Engine, translated and extended", snippet: "The Engine might act upon other things besides number, were objects found whose mutual fundamental relations could be expressed", unread: true },
  { from: "Grace Hopper", time: "Mon", subject: "Nanoseconds", snippet: "Here is a piece of wire a foot long, which is how far light goes in a nanosecond", unread: false },
  { from: "Alan Turing", time: "Sun", subject: "Can machines think?", snippet: "I propose to consider the question, and the answer depends on the definitions", unread: true },
  { from: "Edsger Dijkstra", time: "Fri", subject: "Go To Statement Considered Harmful", snippet: "For a number of years I have been familiar with the observation", unread: false },
]

/** A row of the bench's mailbox: a positioned root with `user-select: none`, a click listener and a hover style, whose children are absolute, and one-line texts that clip (`overflow: hidden`). */
function MailRow(props: { index: number; step: Accessor<number>; selected: Accessor<number> }) {
  const message = () => MESSAGES[(props.index + props.step()) % MESSAGES.length]
  const unread = () => message().unread
  return (
    <div
      style={{
        position: "relative",
        height: ROW_HEIGHT,
        borderBottom: "1px solid #F4F4F5",
        userSelect: "none",
        backgroundColor: props.selected() === props.index ? "#DBEAFE" : "#FFFFFF",
        hover: { backgroundColor: props.selected() === props.index ? "#DBEAFE" : "#F4F4F5" },
      }}
      onClick={() => heard.push(`click row ${props.index}`)}
    >
      <Show when={unread()}>
        <div style={{ position: "absolute", left: 4, top: 17, width: 8, height: 8, borderRadius: 4, backgroundColor: "#2563EB" }} />
      </Show>
      <div
        style={{
          position: "absolute",
          left: 16,
          top: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: AVATAR_COLORS[(props.index + props.step()) % 8],
        }}
      >
        <text style={{ fontSize: 13, fontWeight: 600, color: "#FFFFFF" }}>{message().from.slice(0, 2)}</text>
      </div>
      <div style={{ position: "absolute", left: 64, right: 16, top: 12, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, height: 18 }}>
          <text style={{ ...ONE_LINE, minWidth: 0, fontSize: 13, fontWeight: unread() ? 600 : 500, color: unread() ? "#18181B" : "#3F3F46" }}>{message().from}</text>
          <text style={{ flexShrink: 0, fontSize: 12, color: "#71717A" }}>{message().time}</text>
        </div>
        <text style={{ ...ONE_LINE, height: 18, lineHeight: "18px", fontSize: 13, color: "#27272A" }}>{message().subject}</text>
        <text style={{ ...ONE_LINE, height: 16, lineHeight: "16px", fontSize: 12, color: "#71717A" }}>{message().snippet}</text>
      </div>
    </div>
  )
}

const scenes: Scene[] = [
  {
    name: "nested-boxes",
    steps: 4,
    width: 320,
    height: 260,
    directRoots: 2,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }}>
        <div style={{ margin: 8, padding: [4, 12, 20, 8][step()], border: "2px solid #223344", borderRadius: 10, backgroundColor: ["#ddeeff", "#ffeedd", "#ddeeff", "#eeffdd"][step()] }}>
          <div style={{ margin: "6px 10px", padding: 6, border: "1px dashed #884400", borderRadius: 4, backgroundColor: "#ffffff" }}>
            <div style={{ height: [20, 30, 20, 44][step()], margin: 4, backgroundColor: "#99bbdd", borderRadius: 3 }} />
            <div style={{ height: 12, marginTop: 6, borderTop: "3px solid #cc3300", backgroundColor: "#ccddee" }} />
          </div>
        </div>
        <div style={{ ...CARD, width: [200, 260, 200, 120][step()] }} />
      </div>
    ),
  },
  {
    name: "flex",
    steps: 4,
    width: 360,
    height: 260,
    directRoots: 2,
    view: (step) => (
      <div style={{ width: 340, backgroundColor: "#ffffff" }}>
        <div style={{ display: "flex", flexDirection: "row", gap: [4, 12, 4, 20][step()], padding: 6, backgroundColor: "#f4f4f4" }}>
          <div style={{ width: 60, height: 30, backgroundColor: "#cc4444" }} />
          <div style={{ flexGrow: 1, height: 30, backgroundColor: "#44cc44" }} />
          <div style={{ width: [40, 80, 40, 20][step()], height: 30, backgroundColor: "#4444cc" }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10, padding: 6, alignItems: (["flex-start", "center", "flex-end", "stretch"] as const)[step()] }}>
          <div style={{ width: 80, height: 16, backgroundColor: "#cc8844" }} />
          <div style={{ width: 140, height: 16, backgroundColor: "#44cc88" }} />
          <div style={{ width: 60, height: 16, backgroundColor: "#8844cc" }} />
        </div>
      </div>
    ),
  },
  {
    name: "inherited-text",
    steps: 4,
    width: 360,
    height: 260,
    directRoots: 1,
    view: (step) => (
      <div style={{ width: 340, backgroundColor: "#ffffff" }}>
        <div style={{ fontSize: [16, 20, 16, 12][step()], fontWeight: [400, 700, 400, 600][step()], color: ["#aa2200", "#0044aa", "#aa2200", "#008844"][step()], padding: 8 }}>
          <text>{() => ["first line", "first line, longer", "first", "first line"][step()]}</text>
          <div style={{ marginTop: 4, padding: 4, backgroundColor: "#eef" }}>
            <text>inherits everything</text>
            <text style={{ color: "#000000", fontSize: 11 }}>{() => `own style ${step()}`}</text>
          </div>
          <text style={{ fontWeight: 400 }}>{"plain " + "weight"}</text>
        </div>
      </div>
    ),
  },
  {
    name: "em-units",
    steps: 4,
    width: 360,
    height: 220,
    directRoots: 2,
    view: (step) => (
      <div style={{ backgroundColor: "#ffffff", width: 340 }}>
        <div style={{ fontSize: [12, 20, 12, 28][step()], color: "#aa2200", display: "flex" }}>
          {[0, 1, 2].map((index) => (
            <div style={{ width: "2em", height: "1.2em", margin: "0 0.5em", borderLeft: "0.25em solid currentColor", backgroundColor: "currentColor", borderRadius: "0.3em" }}>
              <text style={{ fontSize: "0.5em", color: "#ffffff" }}>{`${index}`}</text>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 16, padding: "0.5em 1em", margin: "0.25rem" }}>
          <div style={{ width: ["10em", "12em", "10em", "5em"][step()], height: "2em", backgroundColor: "#99bbdd" }} />
        </div>
      </div>
    ),
  },
  {
    name: "nowrap-ellipsis",
    steps: 3,
    width: 320,
    height: 220,
    directRoots: 3,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }}>
        <div style={{ width: [120, 90, 200][step()], margin: 4 }}>
          <text style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", fontSize: 14, color: "#223344" }}>{() => ["a long line that does not fit in its box", "short", "another long line that does not fit in its box either"][step()]}</text>
        </div>
        <div style={{ width: 100, margin: 4 }}>
          <text style={{ whiteSpace: "nowrap", fontSize: 14 }}>nowrap with no ellipsis, longer than the box</text>
        </div>
        <div style={{ width: 100, margin: 4, backgroundColor: "#f4f4f4" }}>
          <text style={{ fontSize: 14 }}>wrapping text in a narrow box wraps on its words</text>
        </div>
      </div>
    ),
  },
  {
    name: "inline-spans",
    steps: 3,
    width: 320,
    height: 200,
    directRoots: 2,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }}>
        <div style={{ ...CARD }}>
          <text>
            Hello <span style={{ color: ["#cc0000", "#0000cc", "#cc0000"][step()], fontWeight: 700 }}>big <span style={{ backgroundColor: "#ffff00" }}>{["world", "there", "world"][step()]}</span></span>!
          </text>
        </div>
        <text style={{ ...CARD, whiteSpace: "nowrap", textOverflow: "ellipsis", width: [100, 160, 100][step()] }}>a text host that is a root of its own</text>
      </div>
    ),
  },
  {
    name: "rows-hover",
    steps: 4,
    width: 320,
    height: 260,
    directRoots: 8,
    view: () => (
      <div style={{ width: 300, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }}>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
          <div style={{ ...CARD, cursor: index % 2 ? "pointer" : "default", hover: { backgroundColor: "#ffddaa", borderColor: "#aa5500" } }}>
            <text style={{ fontSize: 13, color: "#112233" }}>{`row ${index}`}</text>
          </div>
        ))}
      </div>
    ),
    act: (renderer, step) => {
      renderer.nativeSimulateMouseMove(40, [0, 40, 100, 400][step])
      renderer.dispatchNativeEvents()
    },
  },
  {
    name: "ineligible",
    steps: 3,
    width: 320,
    height: 300,
    directRoots: 0,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }}>
        <div style={{ ...CARD, overflow: "scroll", height: 20 }} />
        <div style={{ ...CARD, position: "sticky", top: 0, height: 20 }} />
        <div style={{ ...CARD, position: "relative", zIndex: 2, height: 20, opacity: 0.9 }} />
        <div style={{ ...CARD, opacity: [1, 0.5, 1][step()], height: 20 }} />
        <div style={{ ...CARD, height: 20 }} onClick={() => {}} tabIndex={0} />
        <div style={{ ...CARD, height: 20, visibility: "hidden" }} />
        <div style={{ ...CARD, height: 20, transform: ["rotate(0deg)", "rotate(2deg)", "rotate(0deg)"][step()] }} />
        <div style={{ ...CARD, height: 20, overflow: "auto" }} />
      </div>
    ),
  },
  {
    name: "ineligible-next-to-eligible",
    steps: 3,
    width: 320,
    height: 300,
    // The page root is a context of its own, and so is the clipped box: the plain boxes around it are direct, and so is the
    // positioned one with an absolute child, which is lifted to the context of the page. A static box with an absolute child is
    // not (what places the child is outside it), and the child, a root of its own, is.
    directRoots: 5,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }}>
        <div style={{ ...CARD, backgroundColor: ["#eef3f8", "#ffeedd", "#eef3f8"][step()] }}>
          <text>{() => `plain ${step()}`}</text>
        </div>
        <div style={{ ...CARD, overflow: "hidden", height: 40 }}>
          <text>clipped, so a scroller</text>
          <div style={{ height: 80, backgroundColor: "#99bbdd" }} />
        </div>
        <div style={{ ...CARD, position: "relative" }}>
          <div style={{ position: "absolute", top: [2, 6, 10][step()], right: 4, width: 20, height: 12, backgroundColor: "#cc4444" }} />
          <text>positioned child</text>
        </div>
        <div style={{ ...CARD, opacity: [1, 0.5, 1][step()] }}>
          <text>faded</text>
        </div>
        <div style={{ ...CARD, height: 20 }}>
          <div style={{ position: "absolute", top: [2, 6, 10][step()], right: 4, width: 20, height: 12, backgroundColor: "#cc4444" }} />
        </div>
        <div style={{ ...CARD }}>
          <div style={{ padding: 4, backgroundColor: "#ddd" }}>
            <text>nested plain</text>
          </div>
        </div>
      </div>
    ),
  },  {
    name: "mail-rows",
    steps: 4,
    width: 320,
    height: 4 * ROW_HEIGHT,
    directRoots: 4,
    directNodes: 4 * 9,
    hears: true,
    view: (step) => {
      const selected = () => [0, 2, 2, 3][step()]
      return (
        <div style={{ width: 300, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }} onPointerMove={hear("page")}>
          {[0, 1, 2, 3].map((index) => (
            <MailRow index={index} step={step} selected={selected} />
          ))}
        </div>
      )
    },
    act: (renderer, step) => {
      // Over the avatar, the text column and the bare row of one row, then out; a click on each.
      const row = [1, 2, 0, 3][step]
      for (const [x, y] of [[30, 20], [100, 30], [100, 62], [280, 66], [400, 400]]) {
        renderer.nativeSimulateMouseMove(x, row * ROW_HEIGHT + y)
        renderer.dispatchNativeEvents()
      }
      renderer.nativeSimulateClick(30, row * ROW_HEIGHT + 20)
      renderer.nativeSimulateClick(160, row * ROW_HEIGHT + 66)
      renderer.dispatchNativeEvents()
    },
  },
  {
    name: "user-select",
    steps: 4,
    width: 320,
    height: 240,
    directRoots: 7,
    directNodes: 7 * 2,
    hears: true,
    view: (step) => (
      <div style={{ width: 300, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }}>
        <div style={{ ...CARD }}>
          <text>{() => `selectable ${step()}`}</text>
        </div>
        <div style={{ ...CARD, userSelect: "none" }}>
          <text>not selectable</text>
        </div>
        <div style={{ ...CARD, userSelect: "none" }}>
          <div>
            <text>inherits none</text>
          </div>
        </div>
        <div style={{ ...CARD, userSelect: "none" }}>
          <text style={{ userSelect: "text" }}>reopened by its own text</text>
        </div>
        <div style={{ ...CARD, userSelect: (["none", "text", "auto", "none"] as const)[step()] }}>
          <text>{() => `toggles ${step()}`}</text>
        </div>
        <div style={{ ...CARD, userSelect: "text" }}>
          <div style={{ userSelect: "none" }}>
            <text>none inside text</text>
          </div>
        </div>
        <div style={{ ...CARD, userSelect: "text" }}>
          <div>
            <text>text inside text</text>
          </div>
        </div>
      </div>
    ),
    act: (renderer) => {
      // A drag that starts in each card, one across all of them, and the copy of what it selected.
      for (let card = 0; card < 7; card++) {
        const y = 15 + 30 * card
        heard.push(`drag ${card}: ${renderer.dragSelect(12, y, 900, y)}`)
        renderer.clearSelection()
      }
      heard.push(`drag all: ${renderer.dragSelect(12, 15, 900, 215)}`)
      renderer.simulateKeystrokes("Meta+c")
      heard.push(`copied: ${renderer.readClipboardText()}`)
      renderer.clearSelection()
      renderer.dispatchNativeEvents()
    },
  },
  {
    name: "overflow-hidden",
    steps: 5,
    width: 320,
    height: 320,
    directRoots: 4,
    hears: true,
    view: (step) => (
      <div style={{ width: 300, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }}>
        <div ref={named("box")} style={{ ...CARD, width: [160, 160, 200, 160, 160][step()], height: 48, overflow: "hidden" }}>
          <text style={{ ...ONE_LINE, fontSize: 13 }}>{() => ["a long line that does not fit in its box", "short", "another long line that does not fit in its box either", "a long line that does not fit in its box", "short"][step()]}</text>
          <div style={{ height: 40, backgroundColor: "#99bbdd" }} />
          <div style={{ height: 60, backgroundColor: "#ddbb99", borderTop: "3px solid #884400" }}>
            <text style={{ fontSize: 12 }}>below the fold</text>
          </div>
        </div>
        <div ref={named("outer")} style={{ ...CARD, height: 70, overflow: "hidden" }}>
          <div style={{ height: 20, backgroundColor: "#ccddee" }} />
          <div ref={named("inner")} style={{ height: 36, overflow: "hidden", backgroundColor: "#eef3f8" }}>
            <text style={{ fontSize: 12 }}>inner line one</text>
            <text style={{ fontSize: 12 }}>inner line two</text>
            <text style={{ fontSize: 12 }}>inner line three</text>
          </div>
          <div style={{ height: 40, backgroundColor: "#bbddaa" }} />
        </div>
        <text ref={named("line")} style={{ ...ONE_LINE, width: 100, margin: 6, fontSize: 14 }}>{() => `a ${["long", "much longer", "long", "short", "long"][step()]} line that the box clips`}</text>
        <div style={{ ...CARD, height: 30 }}>
          <text>{() => `beside the scrollers ${step()}`}</text>
        </div>
      </div>
    ),
    act: (_renderer, step) => {
      // Scripts scroll them (the user cannot), and read the range back; a step that sets what was set before leaves
      // the boxes to be replayed with the offset they have.
      hosts.box.scrollTop = [30, 30, 80, 80, 0][step]
      hosts.outer.scrollTop = [10, 10, 25, 25, 0][step]
      hosts.inner.scrollTop = [0, 14, 14, 14, 3][step]
      hosts.line.scrollLeft = [0, 0, 12, 12, 0][step]
      heard.push(...["box", "outer", "inner", "line"].map(scrollState))
    },
  },
  {
    name: "z-order",
    steps: 4,
    width: 320,
    height: 220,
    directRoots: 4,
    hears: true,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }} onPointerMove={hear("page")}>
        <div style={{ ...CARD, position: "relative", height: 40, backgroundColor: ["#eef3f8", "#f8eef3", "#eef3f8", "#f3f8ee"][step()] }}>
          <div style={{ position: "absolute", top: [28, 24, 28, 30][step()], left: 20, width: 120, height: 30, backgroundColor: "#cc4444" }} />
          <text>{() => `positioned above the static box ${step()}`}</text>
        </div>
        <div style={{ ...CARD, height: 40, backgroundColor: "#fdeeee" }}>
          <text>static, below the child above</text>
        </div>
        <div style={{ ...CARD, position: "relative", height: 40 }}>
          <div style={{ position: "absolute", top: 28, left: [160, 150, 160, 120][step()], width: 100, height: 30, backgroundColor: "#4444cc" }}>
            <text style={{ color: "#ffffff", fontSize: 11 }}>child of D</text>
          </div>
        </div>
        <div style={{ ...CARD, position: "relative", height: 40, backgroundColor: "#fdfbe0" }}>
          <text>positioned later, above the child before</text>
        </div>
      </div>
    ),
    act: (renderer, step) => {
      // Over the child that overlaps the static box, over the child that a later positioned box covers, and over the cover.
      const points = [[40, 66], [40, 80], [200, 128], [200, 150], [130, 150], [400, 400]]
      for (const [x, y] of [...points.slice(step % 2), ...points.slice(0, step % 2)]) {
        renderer.nativeSimulateMouseMove(x, y)
        renderer.dispatchNativeEvents()
      }
    },
  },
  {
    name: "list-mail-rows",
    steps: 4,
    width: 320,
    height: 4 * ROW_HEIGHT,
    directRoots: 6,
    directNodes: 6 * 9,
    hears: true,
    view: (step) => {
      const start = () => [0, 0, 3, 5][step()]
      const selected = () => [0, 2, 2, 3][step()]
      return (
        <div style={{ width: 300 }} onPointerMove={hear("page")}>
          <virtual-list testId="list" itemCount={40} windowStart={start()} estimatedItemHeight={ROW_HEIGHT} style={{ width: 300, height: 4 * ROW_HEIGHT, backgroundColor: "#ffffff" }}>
            <For each={Array.from({ length: 8 }, (_, offset) => start() + offset)}>
              {(index) => <MailRow index={index} step={step} selected={selected} />}
            </For>
          </virtual-list>
        </div>
      )
    },
    act: (renderer, step) => {
      // The pointer crosses the rows (the avatar, the text column, the bare row) and clicks, then the list scrolls to mount others.
      const list = renderer.findByTestId("list")!.id
      for (const [x, y] of [[30, 20], [100, 30], [100, 62], [280, 66], [30, 100], [100, 150], [400, 400]]) {
        renderer.nativeSimulateMouseMove(x, y + (step % 2) * 10)
        renderer.dispatchNativeEvents()
      }
      renderer.nativeSimulateClick(30, 20 + ROW_HEIGHT * (step % 3))
      renderer.dispatchNativeEvents()
      renderer.scrollToItem(list, [0, 1, 3, 5][step])
      renderer.drawFrame()
      heard.push(`scroll ${renderer.getListScrollTop(list)?.join(",")}`)
    },
  },
  {
    name: "list-z-order",
    steps: 4,
    width: 320,
    height: 280,
    directRoots: 5,
    hears: true,
    view: (step) => {
      const start = () => [0, 0, 2, 3][step()]
      // The absolute child of a row hangs over the next row, which paints after it: a row is a context of its own.
      const row = (index: number) => {
        const kind = index % 4
        const shade = ["#eef3f8", "#f8eef3", "#f3f8ee", "#fdfbe0"][(index + step()) % 4]
        const overhang = <div style={{ position: "absolute", top: [26, 30, 26, 22][step()], left: 20 + 30 * kind, width: 90, height: 26, backgroundColor: "#cc4444" }} />
        return (
          <div
            style={{
              ...CARD,
              position: kind === 3 ? "static" : "relative",
              zIndex: kind === 1 ? 2 : undefined,
              height: 40,
              backgroundColor: shade,
            }}
          >
            <text>{() => `row ${index}, kind ${kind}, step ${step()}`}</text>
            {overhang}
            <Show when={kind === 2}>
              <div style={{ position: "absolute", top: 4, left: 150, width: 60, height: 20, zIndex: -1, backgroundColor: "#44aa44" }} />
              <div style={{ position: "relative", top: 6, width: 80, height: 14, zIndex: 3, backgroundColor: "#4444cc" }} />
            </Show>
          </div>
        )
      }
      return (
        <div style={{ width: 300, backgroundColor: "#ffffff" }} onPointerMove={hear("page")}>
          <virtual-list testId="list" itemCount={30} windowStart={start()} estimatedItemHeight={46} style={{ width: 300, height: 280 }}>
            <For each={Array.from({ length: 8 }, (_, offset) => start() + offset)}>{row}</For>
          </virtual-list>
        </div>
      )
    },
    act: (renderer, step) => {
      // Over the child that hangs over the next row, over that row beside it, and over the lifted children.
      const points = [[40, 66], [40, 80], [100, 52], [200, 130], [60, 120], [170, 20], [400, 400]]
      for (const [x, y] of [...points.slice(step % 3), ...points.slice(0, step % 3)]) {
        renderer.nativeSimulateMouseMove(x, y)
        renderer.dispatchNativeEvents()
      }
      renderer.scrollToItem(renderer.findByTestId("list")!.id, [0, 1, 2, 3][step])
      renderer.drawFrame()
    },
  },
  {
    name: "z-index-root",
    steps: 4,
    width: 320,
    height: 240,
    directRoots: 4,
    hears: true,
    // A positioned root with a `z-index` is a stacking context: what is lifted below it stays in it, and it sorts among its siblings.
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }} onPointerMove={hear("page")}>
        <div style={{ ...CARD, position: "relative", zIndex: [2, 2, 1, 3][step()], height: 40, backgroundColor: "#eef3f8" }}>
          <div style={{ position: "absolute", top: [28, 24, 28, 30][step()], left: 20, width: 120, height: 30, backgroundColor: "#cc4444" }} />
          <div style={{ position: "absolute", top: 10, left: 200, width: 60, height: 40, backgroundColor: "#44aa44" }} />
          <text>{() => `context ${step()}`}</text>
        </div>
        <div style={{ ...CARD, position: "relative", zIndex: [1, 1, 2, 1][step()], height: 40, backgroundColor: "#f8eef3" }}>
          <div style={{ position: "absolute", top: -16, left: 60, width: 100, height: 30, backgroundColor: "#4444cc" }} />
          <text>covers or is covered</text>
        </div>
        <div style={{ ...CARD, position: "relative", height: 40, backgroundColor: "#fdfbe0" }}>
          <div style={{ position: "absolute", top: [-20, -10, -20, -30][step()], left: 100, width: 90, height: 40, backgroundColor: "#aa44aa" }} />
          <text>auto, lifted to the page</text>
        </div>
        <div style={{ ...CARD, position: "relative", zIndex: -1, height: 40, backgroundColor: "#eeeeee" }}>
          <text>below the page content</text>
        </div>
      </div>
    ),
    act: (renderer, step) => {
      const points = [[40, 60], [40, 90], [230, 40], [100, 40], [100, 130], [150, 190], [400, 400]]
      for (const [x, y] of [...points.slice(step % 3), ...points.slice(0, step % 3)]) {
        renderer.nativeSimulateMouseMove(x, y)
        renderer.dispatchNativeEvents()
      }
    },
  },
  {
    name: "scroll-anchoring",
    steps: 5,
    width: 340,
    height: 320,
    directRoots: 2,
    view: (step) => {
      // The ids of the rows of each step: rows come and go above the first one in view, and one is put in its middle.
      const ids = () => {
        const rows = Array.from({ length: 20 }, (_, index) => `r${index}`)
        if (step() >= 4) rows.splice(8, 0, "n2")
        if (step() >= 1) rows.unshift("n0")
        if (step() >= 2) rows.unshift("n1")
        return step() >= 3 ? rows.filter((id) => id !== "n0") : rows
      }
      const row = (id: string) => (
        <div style={{ height: id === "n2" ? 30 : id.startsWith("n") ? 100 : 50, flexShrink: 0, backgroundColor: id.startsWith("n") ? "#ddeedd" : "#eef3f8", borderBottom: "1px solid #335577" }}>
          <text style={{ fontSize: 12 }}>{id}</text>
        </div>
      )
      return (
        <div style={{ display: "flex", flexDirection: "row", gap: 10, backgroundColor: "#ffffff" }}>
          <div ref={named("wrapped")} style={{ width: 150, height: 300, overflow: "auto" }}>
            <div>
              <For each={ids()}>{row}</For>
            </div>
          </div>
          <div ref={named("bare")} style={{ width: 150, height: 300, overflow: "auto", display: "flex", flexDirection: "column" }}>
            <For each={ids()}>{row}</For>
          </div>
        </div>
      )
    },
    act: (_renderer, step) => {
      // Scrolled away from the start, a scroller anchors to the first row in view and holds it when rows are inserted above.
      if (step === 0) {
        hosts.wrapped.scrollTop = 400
        hosts.bare.scrollTop = 400
      }
      heard.push(...["wrapped", "bare"].map(scrollState))
    },
  },
]

let shots: string

beforeAll(() => {
  // DIRECT_PAINT_SHOTS keeps the pictures to look at.
  shots = process.env.DIRECT_PAINT_SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), "direct-paint-"))
  fs.mkdirSync(shots, { recursive: true })
})

afterAll(() => {
  // The switch is process wide: leave it as the run found it.
  const root = createTestRoot()
  root.renderer.setDirectPaint(process.env.GPUIX_DIRECT_PAINT === "1")
  root.unmount()
  if (process.env.DIRECT_PAINT_SHOTS === undefined) fs.rmSync(shots, { recursive: true, force: true })
})


function run(scene: Scene, direct: boolean) {
  const app = createTestRoot({ width: scene.width ?? 400, height: scene.height ?? 300 })
  const renderer = app.renderer
  renderer.setDirectPaint(direct)
  renderer.clockPause()
  try {
    heard.length = 0
    const [step, setStep] = createSignal(0)
    app.render(() => scene.view(step))
    renderer.resetBuildCounters()
    const frames = []
    for (let index = 0; index < scene.steps; index++) {
      if (index > 0) app.flushSync(() => setStep(index))
      renderer.dispatchNativeEvents()
      renderer.flush()
      // Direct paint is off while a screen reader is connected, which a test window pretends.
      renderer.setA11yActive(false)
      for (const frame of ["changed", "again"]) {
        if (frame === "again") scene.act?.(renderer, index)
        renderer.drawFrame()
        const heardNow = heard.splice(0)
        const file = path.join(shots, `${scene.name}-${index}-${frame}-${direct ? "on" : "off"}.png`)
        renderer.captureScreenshot(file)
        frames.push({ label: `step ${index}, ${frame}`, picture: fs.readFileSync(file), painted: renderer.getPaintedText(), tree: JSON.parse(renderer.getAutomationTree()), heard: heardNow })
      }
    }
    const counters = renderer.getBuildCounters()
    const retained = renderer.getRetainedCounters()
    return {
      frames,
      roots: counters.directRoots,
      nodes: counters.directNodes,
      hits: retained.hits,
      mismatches: renderer.getRetainMismatches(),
    }
  } finally {
    app.unmount()
  }
}

describeNative("direct paint", { timeout: 120_000 }, () => {
  for (const scene of scenes) {
    it(`draws ${scene.name} as the Divs do`, () => {
      const off = run(scene, false)
      const on = run(scene, true)
      expect(off.roots, "nothing is direct with the switch off").toBe(0)
      if (scene.directRoots === 0) expect(on.roots, "nothing here is plain").toBe(0)
      else expect(on.roots, "the plain roots are drawn direct").toBeGreaterThanOrEqual(scene.directRoots)
      expect(on.nodes, "a direct root holds its nodes").toBeGreaterThanOrEqual(scene.directNodes ?? on.roots)
      expect(on.mismatches, "what a retained root replays is what is built").toEqual([])
      for (let index = 0; index < off.frames.length; index++) {
        const frame = off.frames[index].label
        expect(Buffer.compare(on.frames[index].picture, off.frames[index].picture), `the picture of ${frame}`).toBe(0)
        expect(on.frames[index].painted, `the painted text of ${frame}`).toEqual(off.frames[index].painted)
        expect(on.frames[index].tree, `the automation tree of ${frame}`).toEqual(off.frames[index].tree)
        expect(on.frames[index].heard, `what the page heard in ${frame}`).toEqual(off.frames[index].heard)
      }
      if (scene.hears) expect(off.frames.flatMap((frame) => frame.heard).length, "the pointer reached the page").toBeGreaterThan(0)
    })
  }

  it("draws each row of a list as one direct root", () => {
    const app = createTestRoot({ width: 320, height: 4 * ROW_HEIGHT })
    const renderer = app.renderer
    renderer.setDirectPaint(true)
    renderer.clockPause()
    try {
      const [step] = createSignal(0)
      const [selected] = createSignal(1)
      renderer.setA11yActive(false)
      renderer.resetBuildCounters()
      app.render(() => (
        <virtual-list itemCount={40} estimatedItemHeight={ROW_HEIGHT} style={{ width: 300, height: 4 * ROW_HEIGHT, backgroundColor: "#ffffff" }}>
          <For each={[0, 1, 2, 3, 4, 5]}>{(index) => <MailRow index={index} step={step} selected={selected} />}</For>
        </virtual-list>
      ))
      renderer.drawFrame()
      const counters = renderer.getBuildCounters()
      // A row is the root, the avatar and its text, the column, its two rows and texts, the subject and the snippet, and the
      // dot of an unread one: nine nodes at least, and none of them a root of its own, so the roots are the rows.
      expect(counters.directRoots, "the rows are roots").toBeGreaterThanOrEqual(4)
      expect(counters.directNodes, "every node is in the root of its row").toBeGreaterThanOrEqual(counters.directRoots * 9)
      expect(counters.directNodes, "and no more than a row holds").toBeLessThanOrEqual(counters.directRoots * 10)
    } finally {
      app.unmount()
    }
  })

  it("draws each row of the mailbox as one direct root", () => {
    const app = createTestRoot({ width: 320, height: 4 * ROW_HEIGHT })
    const renderer = app.renderer
    renderer.setDirectPaint(true)
    renderer.clockPause()
    try {
      const [step] = createSignal(0)
      const [selected] = createSignal(1)
      renderer.setA11yActive(false)
      renderer.resetBuildCounters()
      app.render(() => (
        <div style={{ width: 300, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }}>
          {[0, 1, 2, 3].map((index) => (
            <MailRow index={index} step={step} selected={selected} />
          ))}
        </div>
      ))
      renderer.drawFrame()
      const counters = renderer.getBuildCounters()
      // The page is built more than once before it settles (and again by a draw), each build making the same roots, so the
      // count is of rows by builds. The row holds everything: no avatar, text or dot is a root of its own.
      const rows = 4
      const unread = MESSAGES.slice(0, rows).filter((message) => message.unread).length
      // A row is the root, the avatar and its text, the column, its two rows and texts, the subject and the snippet, and the dot of an unread one.
      const nodesPerBuild = rows * 9 + unread
      expect(counters.directRoots, "one root per row").toBeGreaterThanOrEqual(rows)
      expect(counters.directRoots % rows, "whole builds of the page").toBe(0)
      expect(counters.directNodes * rows, "every node is in the root of its row").toBe(counters.directRoots * nodesPerBuild)
    } finally {
      app.unmount()
    }
  })

  it("has the pointer cross the nodes of a root as it crosses Divs", () => {
    const run = (direct: boolean) => {
      const app = createTestRoot({ width: 320, height: 240 })
      const renderer = app.renderer
      renderer.setDirectPaint(direct)
      renderer.clockPause()
      renderer.resetBuildCounters()
      const hosts: Record<string, HostElement> = {}
      const named = (name: string) => (host: HostElement) => void (hosts[name] = host)
      const nameOf = (target: unknown) => Object.keys(hosts).find((name) => hosts[name] === target) ?? String(target)
      const heard: string[] = []
      try {
        app.render(() => (
          <div
            ref={named("page")}
            style={{ width: 300, height: 220, backgroundColor: "#ffffff" }}
            onPointerMove={(event) => heard.push(`${nameOf(event.target)} < ${event.composedPath().map(nameOf).join(" < ")}`)}
          >
            <div ref={named("a")} style={{ ...CARD, margin: 10, width: 200, padding: 0, cursor: "text" }}>
              <div ref={named("a1")} style={{ width: 80, height: 40, backgroundColor: "#99bbdd", cursor: "pointer" }} />
              <div ref={named("a2")} style={{ width: 80, height: 40, backgroundColor: "#ddbb99", pointerEvents: "none" }}>
                <div ref={named("a2x")} style={{ width: 30, height: 30, backgroundColor: "#bbdd99", pointerEvents: "auto", cursor: "grab" }} />
              </div>
              <div ref={named("a3")} style={{ width: 80, height: 20, backgroundColor: "#dd99bb" }}>
                <text ref={named("a3t")} style={{ fontSize: 11 }}>label</text>
              </div>
            </div>
          </div>
        ))
        renderer.dispatchNativeEvents()
        renderer.flush()
        renderer.setA11yActive(false)
        renderer.drawFrame()
        const crossings = [
          [10, 20],
          [20, 30],
          [30, 60],
          [60, 70],
          [60, 100],
          [150, 20],
          [250, 20],
          [400, 400],
        ].map(([x, y]) => {
          renderer.nativeSimulateMouseMove(x, y)
          renderer.drawFrame()
          return { x, y, heard: heard.splice(0), cursor: renderer.getCursor() }
        })
        const boxes = Object.fromEntries(Object.entries(hosts).map(([name, host]) => [name, host.getBoundingClientRect()]))
        return { crossings, boxes, roots: renderer.getBuildCounters().directRoots }
      } finally {
        app.unmount()
      }
    }
    const off = run(false)
    const on = run(true)
    expect(off.roots).toBe(0)
    expect(on.roots, "the card is a root of its own").toBeGreaterThanOrEqual(1)
    expect(on.crossings).toEqual(off.crossings)
    expect(on.boxes).toEqual(off.boxes)
    expect(on.crossings.map((crossing) => crossing.heard)).toEqual([
      ["a < a < page"],
      ["a1 < a1 < a < page"],
      ["a2x < a2x < a2 < a < page"],
      ["a < a < page"],
      ["a3t < a3t < a3 < a < page"],
      ["a < a < page"],
      ["page < page"],
      [],
    ])
    expect(on.crossings.map((crossing) => crossing.cursor)).toEqual(["text", "pointer", "grab", "text", "text", "text", "default", "default"])
  })
})
