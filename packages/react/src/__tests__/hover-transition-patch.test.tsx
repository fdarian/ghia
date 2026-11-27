// @ts-nocheck
/**
 * A hover that only paints and whose element declares a transition that runs on colours is drawn by patch frames: the hover
 * is a patch that builds the root (which starts the transition), and every tick of the run builds it again, as a tick of
 * a CSS transition on a page that was built whole (`events/hover_paint.rs`, patch-frames.md "Hover patches"). A transition that can
 * run on more than a colour (`all`, `opacity`) leaves the hover to a frame built whole. What the page shows is what patching
 * off draws at the same instant, and the events of the run fire when they are due.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { flushSync, useMotionValue } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// Under the retention verifier a patch is compared with the frame built whole after it, and a frame that replays roots is built twice:
// the cases that count frames skip there, and every case checks `mismatches`.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

const ROW = 40
const COUNT = 6
const DURATION = 200
const FRAME = 16
const TIMEOUT = 60_000
/** Over the row 1, and outside every row. */
const ON = [20, 60] as const
const OFF = [250, 230] as const

/** The transition of a row, and what its hover changes. */
type Variant = "background" | "colour" | "all" | "opacity" | "child" | "none"

const TRANSITIONS: Record<Variant, string | undefined> = {
  background: `background-color ${DURATION}ms linear`,
  colour: `color ${DURATION}ms linear, background-color ${DURATION}ms linear`,
  all: `all ${DURATION}ms linear`,
  opacity: `opacity ${DURATION}ms linear`,
  child: undefined,
  none: undefined,
}

/** The colour a row has at rest, and the one a commit gives it (`Tinted`). */
const REST = "#223344"
const TINT = "#443322"

function Row({ index, variant, seen, tint }: { index: number; variant: Variant; seen: string[]; tint?: boolean }) {
  if (variant === "child") {
    // The row declares nothing that runs: the child has a background of its own and a transition of it, and the row's hover changes
    // it through `groupHover`, so what starts the run is an element below the one the hover restyles.
    return (
      <div testId={`row-${index}`} style={{ width: 150, height: ROW, flexShrink: 0, group: true }}>
        <div
          testId={`child-${index}`}
          style={{
            width: 150,
            height: ROW,
            backgroundColor: REST,
            transition: `background-color ${DURATION}ms linear`,
            groupHover: { backgroundColor: "#664422" },
          }}
          onTransitionRun={(event) => seen.push(`run ${index} ${event.propertyName}`)}
          onTransitionEnd={(event) => seen.push(`end ${index} ${event.propertyName}`)}
        >{`row-${index}`}</div>
      </div>
    )
  }
  const style =
    variant === "colour"
      ? {
          width: 150,
          height: ROW,
          flexShrink: 0,
          color: "#ffffff",
          backgroundColor: "#223344",
          transition: TRANSITIONS.colour,
          hover: { color: "#ff0000", backgroundColor: "#664422" },
        }
      : {
          width: 150,
          height: ROW,
          flexShrink: 0,
          backgroundColor: tint ? TINT : REST,
          borderBottom: "1px solid #112233",
          transition: TRANSITIONS[variant],
          hover: { backgroundColor: "#664422" },
        }
  return (
    <div
      testId={`row-${index}`}
      style={style}
      onTransitionEnd={(event) => seen.push(`end ${index} ${event.propertyName}`)}
      onTransitionRun={(event) => seen.push(`run ${index} ${event.propertyName}`)}
    >
      <div style={{ color: variant === "colour" ? undefined : "#ffffff" }}>{`row-${index}`}</div>
    </div>
  )
}

function Page({ variant, seen }: { variant: Variant; seen: string[] }) {
  return (
    <div testId="column" style={{ width: 200, height: ROW * COUNT, flexDirection: "column", overflow: "hidden" }}>
      {Array.from({ length: COUNT }, (_, index) => (
        <Row key={index} index={index} variant={variant} seen={seen} />
      ))}
    </div>
  )
}

async function open(variant: Variant, patch: boolean, seen: string[] = []) {
  return openPage(<Page variant={variant} seen={seen} />, patch, seen)
}

async function openPage(page: React.ReactElement, patch: boolean, seen: string[] = []) {
  const root = createTestRoot({ width: 300, height: 260 })
  const renderer = root.renderer
  renderer.clockPause()
  root.render(page)
  renderer.dispatchNativeEvents()
  renderer.flush()
  renderer.setA11yActive(false)
  renderer.setPatchEnabled(patch)
  // Frames that record the page, and one run of the transition of a row, so the rows are known to the frames that follow.
  move(renderer, ...ON)
  elapse(renderer, DURATION + FRAME * 2)
  move(renderer, ...OFF)
  elapse(renderer, DURATION + FRAME * 2)
  renderer.dispatchNativeEvents()
  seen.length = 0
  return root
}

function move(renderer, x: number, y: number) {
  renderer.nativeSimulateMouseMove(x, y)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

/** Time passes for the window without it being told, a frame at a time, as it does in a live one. */
function elapse(renderer, ms: number) {
  for (let left = ms; left > 0; left -= FRAME) {
    renderer.clockAdvance(Math.min(FRAME, left))
    renderer.drawFrame()
  }
}

/** The frame that was drawn last as it is: `captureScreenshot` refreshes the window and would capture a frame built whole. */
function picture(renderer, name: string): string {
  const file = `${SHOTS_DIR}/hover-transition-patch-${process.pid}-${name}.png`
  fs.rmSync(file, { force: true })
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

const sum = (reasons: string) => Object.values(JSON.parse(reasons)).reduce((a: number, b: number) => a + b, 0)

function counters(renderer) {
  const patches = renderer.getPatchCounters()
  return {
    patchedFrames: patches.patchedFrames,
    sceneRebuilds: patches.sceneRebuilds,
    refused: sum(patches.declines) + sum(patches.unpatchable),
    painted: renderer.getPaintedFrameCount(),
  }
}

/** What `step` did, in frames. */
function frames(renderer, step: () => void) {
  const before = counters(renderer)
  step()
  const after = counters(renderer)
  return {
    patched: after.patchedFrames - before.patchedFrames,
    sceneRebuilds: after.sceneRebuilds - before.sceneRebuilds,
    refused: after.refused - before.refused,
    painted: after.painted - before.painted,
  }
}

/** The page at the instants of a hover and a leave: `at` ticks after the pointer entered the row, or after it left. */
const INSTANTS = [
  { name: "enter", leave: false, ticks: 0 },
  { name: "enter-6", leave: false, ticks: 6 },
  { name: "enter-12", leave: false, ticks: 12 },
  { name: "enter-20", leave: false, ticks: 20 },
  { name: "leave", leave: true, ticks: 0 },
  { name: "leave-6", leave: true, ticks: 6 },
  { name: "leave-20", leave: true, ticks: 20 },
] as const

async function pictureAt(variant: Variant, patch: boolean, instant: (typeof INSTANTS)[number]) {
  const root = await open(variant, patch)
  const renderer = root.renderer
  try {
    move(renderer, ...ON)
    if (instant.leave) {
      elapse(renderer, DURATION + FRAME * 2)
      move(renderer, ...OFF)
    }
    elapse(renderer, instant.ticks * FRAME)
    const shown = picture(renderer, `${variant}-${patch}-${instant.name}`)
    return { shown, mismatches: renderer.getRetainedCounters().mismatches }
  } finally {
    root.unmount()
  }
}

describeNative("a hover whose element transitions colours", { timeout: TIMEOUT }, () => {
  for (const variant of ["background", "colour", "child"] as const) {
    // A group is a frame built whole (`uses_groups`): what the `child` rows show is the same as with patching off, and no count is pinned.
    (variant === "child" ? it.skip : unverified)(`is a patched frame, then a patched frame for every tick of the run, and likewise for the leave, with ${variant}`, async () => {
      const root = await open(variant, true)
      const renderer = root.renderer
      try {
        // The test window draws the tick the hover asks for in the same step, so the hover is up to two patched frames.
        const enter = frames(renderer, () => move(renderer, ...ON))
        expect(enter.patched, "the hover").toBeGreaterThanOrEqual(1)
        expect(enter.patched).toBeLessThanOrEqual(2)
        expect(enter.painted, "no frame is built whole").toBe(0)
        expect(enter.refused).toBe(0)
        expect(enter.sceneRebuilds).toBe(0)

        // The transition is 200 ms: 12 ticks of 16 ms are 192 of it.
        const run = frames(renderer, () => elapse(renderer, FRAME * 12))
        expect(run.patched, "every tick of the run").toBe(12)
        expect(run.painted).toBe(0)
        expect(run.refused).toBe(0)
        expect(run.sceneRebuilds).toBe(0)

        const end = frames(renderer, () => elapse(renderer, FRAME))
        expect(end.patched, "the tick that ends it").toBe(1)
        expect(end.painted).toBe(0)
        const after = frames(renderer, () => elapse(renderer, FRAME * 6))
        expect(after.patched, "a transition that ended asks for no tick").toBe(0)
        expect(after.painted).toBe(0)

        const leave = frames(renderer, () => move(renderer, ...OFF))
        expect(leave.patched, "the leave").toBeGreaterThanOrEqual(1)
        expect(leave.patched).toBeLessThanOrEqual(2)
        expect(leave.painted).toBe(0)
        const back = frames(renderer, () => elapse(renderer, FRAME * 13))
        expect(back.patched, "the run back").toBeGreaterThanOrEqual(12)
        expect(back.patched).toBeLessThanOrEqual(13)
        expect(back.painted).toBe(0)
        expect(back.refused).toBe(0)
        expect(renderer.getRetainedCounters().mismatches).toBe(0)
      } finally {
        root.unmount()
      }
    })

    it(`fires the events of the run when they are due, with ${variant}`, async () => {
      const seen: string[] = []
      const root = await open(variant, true, seen)
      const renderer = root.renderer
      const ends = () => seen.filter((event) => event.startsWith("end")).sort()
      const expected = variant === "colour" ? ["end 1 background-color", "end 1 color"] : ["end 1 background-color"]
      try {
        move(renderer, ...ON)
        renderer.dispatchNativeEvents()
        expect(seen.filter((event) => event.startsWith("run 1")), "a run per property").toHaveLength(expected.length)
        elapse(renderer, FRAME * 12)
        renderer.dispatchNativeEvents()
        expect(ends(), "not at 192 ms").toEqual([])
        elapse(renderer, FRAME)
        renderer.dispatchNativeEvents()
        expect(ends(), "at 208 ms").toEqual(expected)
        seen.length = 0
        move(renderer, ...OFF)
        elapse(renderer, FRAME * 12)
        renderer.dispatchNativeEvents()
        expect(ends(), "not at 192 ms of the leave").toEqual([])
        elapse(renderer, FRAME)
        renderer.dispatchNativeEvents()
        expect(ends(), "at 208 ms of the leave").toEqual(expected)
        expect(renderer.getRetainedCounters().mismatches).toBe(0)
      } finally {
        root.unmount()
      }
    })

    for (const instant of INSTANTS) {
      it(`shows what patching off shows at ${instant.name}, with ${variant}`, async () => {
        const on = await pictureAt(variant, true, instant)
        const off = await pictureAt(variant, false, instant)
        expect(on.shown === off.shown).toBe(true)
        expect(on.mismatches).toBe(0)
      })
    }

    it(`shows a run in progress that is neither end of it, with ${variant}`, async () => {
      const start = await pictureAt(variant, true, INSTANTS[0])
      const middle = await pictureAt(variant, true, INSTANTS[1])
      const end = await pictureAt(variant, true, INSTANTS[3])
      expect(middle.shown).not.toEqual(start.shown)
      expect(middle.shown).not.toEqual(end.shown)
      expect(end.shown).not.toEqual(start.shown)
    })
  }

  for (const variant of ["all", "opacity"] as const) {
    unverified(`stays a frame built whole when the transition can run on more than a colour, with ${variant}`, async () => {
      const root = await open(variant, true)
      const renderer = root.renderer
      try {
        const enter = frames(renderer, () => move(renderer, ...ON))
        expect(enter.painted, "the hover is a frame built whole").toBeGreaterThan(0)
      } finally {
        root.unmount()
      }
    })

    it(`shows what patching off shows when the transition can run on more than a colour, with ${variant}`, async () => {
      for (const instant of INSTANTS.filter((instant) => ["enter-6", "leave-6"].includes(instant.name))) {
        const on = await pictureAt(variant, true, instant)
        const off = await pictureAt(variant, false, instant)
        expect(on.shown === off.shown, instant.name).toBe(true)
      }
    })
  }

  unverified("keeps a hover with no transition a patched frame, as it was", async () => {
    const root = await open("none", true)
    try {
      const enter = frames(root.renderer, () => move(root.renderer, ...ON))
      expect(enter.patched).toBe(1)
      expect(enter.painted).toBe(0)
    } finally {
      root.unmount()
    }
  })
})

/** What the pages below do with a colour transition that runs in a root a frame built whole records, or does not. */
type Layout = "column" | "unit" | "list"

let tintRows!: (tinted: boolean) => void
let editPage!: (edit: number) => void

/**
 * `column`: the rows of `Page`. `unit`: each row is the child of an element with a bound motion value, which is a unit of its own
 * (`Dynamic::MotionValues`, here on a colour, which only paints), so the hover is in a unit and not in a patch root. `list`: the rows are those of a `<virtual-list>`, a scroller.
 * `tintRows(true)` is a commit that changes the colour of row 1 (`Dirty::PaintPatchable`), and `editPage` one that edits the page, which
 * is a frame built whole.
 */
function Layouts({ layout }: { layout: Layout }) {
  const [tinted, setTinted] = React.useState(false)
  const [edit, setEdit] = React.useState(0)
  tintRows = (next) => flushSync(() => setTinted(next))
  editPage = (next) => flushSync(() => setEdit(next))
  const bound = useMotionValue("#ffffff")
  const rows = Array.from({ length: COUNT }, (_, index) => {
    const row = <Row key={index} index={index} variant="background" seen={[]} tint={tinted && index === 1} />
    return layout === "unit" ? (
      <div key={index} testId={`unit-${index}`} style={{ width: 150, height: ROW, flexShrink: 0, color: bound }}>
        {row}
      </div>
    ) : (
      row
    )
  })
  return (
    <>
      {layout === "list" ? (
        <virtual-list testId="list" itemCount={COUNT} estimatedItemHeight={ROW} overdraw={0} style={{ width: 200, height: ROW * 3, scrollbarWidth: "none" }}>
          {rows}
        </virtual-list>
      ) : (
        <div testId="column" style={{ width: 200, height: ROW * COUNT, flexDirection: "column", overflow: "hidden" }}>
          {rows}
        </div>
      )}
      <div testId="edit" style={{ height: 0 }}>
        {edit}
      </div>
    </>
  )
}

type Snap = (name: string) => void

/** `play` on a page with patching on and with it off: the pictures it took. */
async function played(layout: Layout, play: (renderer, snap: Snap) => void) {
  const results = []
  for (const patch of [true, false]) {
    const root = await openPage(<Layouts layout={layout} />, patch)
    const renderer = root.renderer
    try {
      const pictures: string[] = []
      play(renderer, (name) => pictures.push(picture(renderer, `${layout}-${patch}-${name}`)))
      results.push({
        pictures,
        mismatches: renderer.getRetainedCounters().mismatches,
        unpatchable: JSON.parse(renderer.getPatchCounters().unpatchable) as Record<string, number>,
      })
    } finally {
      root.unmount()
    }
  }
  const [on, off] = results
  return { on, off }
}

function sameAsOff(shown: { on: { pictures: string[]; mismatches: number }; off: { pictures: string[] } }) {
  expect(shown.on.pictures.length).toBeGreaterThan(0)
  shown.on.pictures.forEach((picture, at) => expect(picture === shown.off.pictures[at], `picture ${at}`).toBe(true))
  expect(shown.on.mismatches).toBe(0)
}

const hover = (renderer) => move(renderer, ...ON)
const commit = (renderer) => {
  tintRows(true)
  renderer.drawFrame()
}

describeNative("a colour transition that runs in a root that a patch builds", { timeout: TIMEOUT }, () => {
  for (const layout of ["column", "unit"] as const) {
    for (const [start, started] of [
      [hover, "hover"],
      [commit, "commit"],
    ] as const) {
      unverified(`draws every tick of the run as a patch, started by a ${started}, in the ${layout} layout`, async () => {
        const root = await openPage(<Layouts layout={layout} />, true)
        const renderer = root.renderer
        try {
          const begin = frames(renderer, () => start(renderer))
          expect(begin.patched, `the ${started}`).toBeGreaterThanOrEqual(1)
          expect(begin.painted).toBe(0)
          const run = frames(renderer, () => elapse(renderer, FRAME * 12))
          expect(run.patched, "every tick of the run").toBe(12)
          expect(run.painted).toBe(0)
          expect(run.refused).toBe(0)
          expect(frames(renderer, () => elapse(renderer, FRAME)).patched, "the tick that ends it").toBe(1)
        } finally {
          root.unmount()
        }
      })

      it(`shows what patching off shows during the run, started by a ${started}, in the ${layout} layout`, async () => {
        sameAsOff(
          await played(layout, (renderer, snap) => {
            start(renderer)
            snap("start")
            for (const ticks of [6, 6, 6, 6]) {
              elapse(renderer, FRAME * ticks)
              snap(`after-${ticks}`)
            }
          }),
        )
      })
    }
  }

  for (const [start, started] of [
    [hover, "hover"],
    [commit, "commit"],
  ] as const) {
    unverified(`keeps the ticks of the run patches when a frame is built whole in the middle of it, started by a ${started}`, async () => {
      const root = await openPage(<Layouts layout="column" />, true)
      const renderer = root.renderer
      try {
        start(renderer)
        elapse(renderer, FRAME * 4)
        const whole = frames(renderer, () => {
          editPage(1)
          renderer.drawFrame()
        })
        expect(whole.painted, "the edit is a frame built whole").toBeGreaterThanOrEqual(1)
        const run = frames(renderer, () => elapse(renderer, FRAME * 8))
        expect(run.patched, "the rest of the run").toBe(8)
        expect(run.painted).toBe(0)
        expect(run.refused).toBe(0)
      } finally {
        root.unmount()
      }
    })

    it(`shows what patching off shows when a frame is built whole in the middle of the run, started by a ${started}`, async () => {
      sameAsOff(
        await played("column", (renderer, snap) => {
          start(renderer)
          elapse(renderer, FRAME * 4)
          snap("before")
          editPage(1)
          renderer.drawFrame()
          snap("whole")
          elapse(renderer, FRAME * 4)
          snap("after-4")
          elapse(renderer, FRAME * 6)
          snap("end")
        }),
      )
    })
  }

  it("shows what patching off shows when a unit's run is in a frame built whole", async () => {
    sameAsOff(
      await played("unit", (renderer, snap) => {
        hover(renderer)
        elapse(renderer, FRAME * 4)
        editPage(1)
        renderer.drawFrame()
        snap("whole")
        elapse(renderer, FRAME * 4)
        snap("after-4")
        elapse(renderer, FRAME * 6)
        snap("end")
      }),
    )
  })

  // A run in a root inside a scroller is not recorded by a frame built whole (`Node::holds_only_a_run_a_patch_follows`), so a patch
  // that would start one is declined (`RunningInScroller`) and the frame is built whole.
  it("builds the hover that starts a colour transition in the rows of a scroller whole, and shows what patching off shows", async () => {
    const shown = await played("list", (renderer, snap) => {
      hover(renderer)
      snap("hovered")
      elapse(renderer, FRAME * 4)
      snap("after-4")
      elapse(renderer, FRAME * 14)
      snap("end")
    })
    sameAsOff(shown)
    expect(shown.on.unpatchable.RunningInScroller, "the hover").toBeGreaterThanOrEqual(1)
    expect(shown.off.unpatchable.RunningInScroller).toBeUndefined()
  })

  it("builds the commit that starts a colour transition in the rows of a scroller whole, and shows what patching off shows", async () => {
    const shown = await played("list", (renderer, snap) => {
      commit(renderer)
      snap("committed")
      elapse(renderer, FRAME * 4)
      snap("after-4")
      elapse(renderer, FRAME * 14)
      snap("end")
    })
    sameAsOff(shown)
    expect(shown.on.unpatchable.RunningInScroller, "the commit").toBeGreaterThanOrEqual(1)
  })

  it("shows what patching off shows for a run in the rows of a scroller, with a frame built whole in the middle of it", async () => {
    sameAsOff(
      await played("list", (renderer, snap) => {
        hover(renderer)
        elapse(renderer, FRAME * 4)
        snap("before")
        editPage(1)
        renderer.drawFrame()
        snap("whole")
        elapse(renderer, FRAME * 4)
        snap("after-4")
        elapse(renderer, FRAME * 6)
        snap("end")
      }),
    )
  })

  it("shows what patching off shows for the run that the hover starts after a scroll, in the rows the translate moved", async () => {
    const shown = await played("list", (renderer, snap) => {
      // Every row measured, by showing each once with the translate off: a row with no measured size is a frame built whole.
      const list = renderer.findByTestId("list").id
      renderer.setScrollPatchEnabled(false)
      for (let scrolled = 0; scrolled <= COUNT * ROW; scrolled += 20) renderer.scrollTo(list, 0, scrolled)
      renderer.scrollTo(list, 0, 0)
      renderer.setScrollPatchEnabled(true)
      hover(renderer)
      elapse(renderer, DURATION + FRAME * 2)
      renderer.setRetainPlanning(false)
      renderer.setRetainPlanning(true)
      renderer.flush()
      // The wheel moves the rows by a translate, and the hover follows 500 ms after it: a patch of the two rows that the pointer left
      // and entered, where the translate left them, which starts a run in each.
      renderer.nativeSimulateScrollWheel(...ON, 0, 25)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      snap("scrolled")
      elapse(renderer, 700)
      snap("hovered")
      elapse(renderer, FRAME * 4)
      snap("after-4")
      elapse(renderer, FRAME * 10)
      snap("end")
    })
    sameAsOff(shown)
  })
})
