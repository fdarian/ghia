/**
 * A window draws only the part of the picture a frame changed (docs/fork/paint-and-transforms.md, "Partial redraw") and shows the picture of
 * the frame drawn whole. The picture the frames drawn in part add up to (`capturePartialPicture`, the persistent target of the Metal
 * renderer) is compared, step by step, with what `captureShownFrame` draws of the scene the window holds: hover patches in a list that has
 * rows with a shadow, a wheel that translates the rows, a pointer that leaves. A scene with an effect group (opacity, blur, backdrop blur,
 * drop shadow) or a transparent window is drawn whole, and the picture the window keeps is none or the whole frame's.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, Show, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot } from "../testing.js"
import type { TestRenderer } from "../testing.js"

const TIMEOUT = 120_000
const COUNT = 200
const ROW = 40
const TICK_MS = 1000 / 120
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "partial-redraw-"))

type Group = "opacity" | "blur" | "backdrop-blur" | "drop-shadow"

/** An effect group over the first rows of the list and the header's shadow: two overlapping boxes, so that an opacity group is a group. */
function GroupOver(props: { kind: Group }) {
  const style = () => {
    const base = { position: "absolute", left: 40, top: 40, width: 120, height: 90 } as const
    switch (props.kind) {
      case "opacity":
        return { ...base, opacity: 0.5 }
      case "blur":
        return { ...base, filter: "blur(3px)" }
      case "backdrop-blur":
        return { ...base, backdropFilter: "blur(6px)", backgroundColor: "rgba(255, 255, 255, 0.15)" }
      case "drop-shadow":
        return { ...base, filter: "drop-shadow(6px 6px 4px rgba(0, 0, 0, 0.8))" }
    }
  }
  return (
    <div testId="group" style={style()}>
      <div style={{ width: 70, height: 60, backgroundColor: "#cc3355" }} />
      <div style={{ position: "absolute", left: 30, top: 30, width: 80, height: 50, backgroundColor: "#33aa77" }} />
    </div>
  )
}

function open(options: { group?: () => Group | null; transparent?: boolean } = {}) {
  const app = createTestRoot({ width: 420, height: 500, transparent: options.transparent })
  const group = options.group
  app.render(() => (
    <div style={{ width: 420, height: 500, backgroundColor: "#101820", flexDirection: "column" }}>
      <div style={{ height: 50, backgroundColor: "#203040", boxShadow: "0px 6px 12px rgba(0, 0, 0, 0.6)", padding: 8 }}>
        <text style={{ color: "#ffffff" }}>header</text>
      </div>
      <virtual-list testId="list" itemCount={COUNT} estimatedItemHeight={ROW} style={{ width: 300, height: 400, marginLeft: 20, marginTop: 10 }}>
        <For each={Array.from({ length: 40 }, (_, index) => index)}>
          {(index) => (
            <div
              testId={`row-${index}`}
              style={{ height: ROW, flexShrink: 0, backgroundColor: index % 2 ? "#223344" : "#2a3b4c", hover: { backgroundColor: "#664422" }, padding: 6 }}
            >
              <text style={{ color: "#ffffff" }}>{`row ${index}`}</text>
            </div>
          )}
        </For>
      </virtual-list>
      <Show when={group?.()} keyed>
        {(kind) => <GroupOver kind={kind} />}
      </Show>
    </div>
  ))
  app.renderer.setA11yActive(false)
  app.renderer.setInlineDraws(false)
  return app
}

function tick(renderer: TestRenderer) {
  renderer.clockAdvance(TICK_MS)
  renderer.dispatchNativeEvents()
  renderer.presentFrame()
  renderer.drawFrame()
  renderer.presentFrame()
}

function read(file: string): string {
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

/** The picture of the scene the window holds, and the picture the frames drawn in part left (null when it keeps none). */
function pictures(renderer: TestRenderer, name: string): { whole: string; kept: string | null } {
  const whole = path.join(shots, `${process.pid}-${name}-whole.png`)
  const kept = path.join(shots, `${process.pid}-${name}-kept.png`)
  renderer.captureShownFrame(whole)
  return { whole: read(whole), kept: renderer.capturePartialPicture(kept) ? read(kept) : null }
}

/** The hover and wheel sequence: a patch of two rows per crossing, a translate per wheel step, a pointer that leaves. */
function drive(renderer: TestRenderer, check: (name: string) => void) {
  for (let y = 80; y < 440; y += 17) {
    renderer.dispatchMouseMove(60, y)
    tick(renderer)
    check(`hover-${y}`)
  }
  for (let step = 0; step < 24; step++) {
    renderer.dispatchScrollWheel(60, 200, 0, step < 16 ? 13 : -21, undefined, "moved")
    tick(renderer)
    check(`wheel-${step}`)
  }
  for (const y of [120, 160, 200]) {
    renderer.dispatchMouseMove(60, y)
    tick(renderer)
    check(`hover-after-${y}`)
  }
  renderer.dispatchMouseMove(-5, -5)
  tick(renderer)
  check("out")
}

function settle(renderer: TestRenderer) {
  for (let i = 0; i < 6; i++) tick(renderer)
  renderer.clockAdvance(3000)
  for (let i = 0; i < 10; i++) tick(renderer)
}

describe("partial redraw", () => {
  it(
    "keeps the picture of a frame drawn whole through hover patches, wheel translates and a pointer that leaves",
    () => {
      const app = open()
      try {
        const renderer = app.renderer
        settle(renderer)

        let compared = 0
        const check = (name: string) => {
          const { whole, kept } = pictures(renderer, name)
          expect(kept, `${name}: the window keeps a picture`).not.toBeNull()
          expect(kept === whole, `${name}: the picture kept is the frame drawn whole`).toBe(true)
          compared++
        }

        check("start")
        drive(renderer, check)
        expect(compared).toBeGreaterThan(40)
        expect(renderer.getPatchCounters().patchedFrames).toBeGreaterThan(0)
      } finally {
        app.unmount()
      }
    },
    TIMEOUT,
  )

  for (const kind of ["opacity", "blur", "backdrop-blur", "drop-shadow"] as const) {
    it(
      `shows the frame drawn whole next to and under a ${kind} group, and in the frames after it is gone`,
      () => {
        const [group, setGroup] = createSignal<Group | null>(kind)
        const app = open({ group })
        try {
          const renderer = app.renderer
          settle(renderer)

          let compared = 0
          const check = (name: string) => {
            const { whole, kept } = pictures(renderer, name)
            // A frame with a group is drawn whole and the window keeps no picture; one it keeps is the frame's.
            if (kept !== null) expect(kept === whole, `${kind} ${name}: the picture kept is the frame drawn whole`).toBe(true)
            compared++
          }

          check("start")
          drive(renderer, check)
          expect(renderer.getPatchCounters().patchedFrames).toBeGreaterThan(0)
          expect(compared).toBeGreaterThan(40)

          // The group goes: the frames after it are the ones of a window without it, and the first patch is not drawn on a picture
          // the group left.
          app.flushSync(() => setGroup(null))
          let kept = 0
          const afterwards = (name: string) => {
            const shown = pictures(renderer, name)
            if (shown.kept !== null) {
              expect(shown.kept === shown.whole, `${kind} ${name}: the picture kept is the frame drawn whole`).toBe(true)
              kept++
            }
          }
          settle(renderer)
          afterwards("gone")
          drive(renderer, afterwards)
          expect(kept, `${kind}: the window draws in part again once the group is gone`).toBeGreaterThan(20)
        } finally {
          app.unmount()
        }
      },
      TIMEOUT,
    )
  }

  it(
    "shows the frame drawn whole in a transparent window",
    () => {
      const app = open({ transparent: true })
      try {
        const renderer = app.renderer
        settle(renderer)
        let compared = 0
        const check = (name: string) => {
          // A transparent window is composited over what is behind it, so every frame is drawn whole and the window keeps no picture.
          const { kept } = pictures(renderer, name)
          expect(kept, `${name}: a transparent window keeps no picture`).toBeNull()
          compared++
        }
        check("start")
        drive(renderer, check)
        expect(compared).toBeGreaterThan(40)
        expect(renderer.getPatchCounters().patchedFrames).toBeGreaterThan(0)
      } finally {
        app.unmount()
      }
    },
    TIMEOUT,
  )
})
