// @ts-nocheck
/**
 * A dialog mounted with a scroller whose rows lie below its clip. The frame that mounts it records its roots, and a
 * root of a scroller is recorded with an overscan past the clip (retention.md, "Moving a recording"): the roots in that
 * band are prepainted and painted by the mounting frame, so that the first scroll replays them instead of building them.
 * Beyond the band a root is culled where it stands, as it is without retention.
 *
 * Skipping the band on the first frame was measured on the mount-cost Settings dialog: the mount frame 3.1M instructions
 * cheaper (42.2M to 39.2M), the first scroll 8M (150 px) to 12M (400 px) dearer, because the rows it brings in are
 * built. That is the trade this file pins the other side of.
 */
import React from "react"
import { expect, it } from "vitest"
import { describeNative, setup, verifying } from "./retained-harness.js"

const ROWS = 4

const Row = ({ label }: { label: string }) => (
  <div style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 48, padding: 8 }}>
    <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
      <text style={{ fontSize: 14, color: "#18181B" }}>{label}</text>
      <text style={{ fontSize: 12, color: "#71717A" }}>{`${label} hint`}</text>
    </div>
    <div style={{ width: 36, height: 20, borderRadius: 10, backgroundColor: "#2563EB" }}>
      <div style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: "#FFFFFF" }} />
    </div>
  </div>
)

const Dialog = ({ sections }: { sections: number }) => (
  <div style={{ width: 640, height: 400, display: "flex", flexDirection: "column", backgroundColor: "#FFFFFF" }}>
    <div style={{ height: 40, flexShrink: 0 }}>
      <text>Settings</text>
    </div>
    <div testId="body" style={{ overflowY: "auto", flexGrow: 1, minHeight: 0 }}>
      {Array.from({ length: sections }, (_, section) => (
        <div key={section} style={{ display: "flex", flexDirection: "column" }}>
          <text style={{ fontSize: 16 }}>{`Section ${section}`}</text>
          {Array.from({ length: ROWS }, (_, row) => (
            <Row key={row} label={`row ${section}.${row}`} />
          ))}
        </div>
      ))}
    </div>
  </div>
)

/** What the frame that mounts the dialog prepaints and paints, and what the first scroll builds. */
const mount = (sections: number, recording: boolean) => {
  const view = setup(<div />)
  const { renderer } = view
  renderer.setInlineDraws(false)
  renderer.setRetainEnabled(recording)
  const before = renderer.getFrameWorkCounters()
  const recorded = renderer.getRetainedCounters().builds
  view.render(<Dialog sections={sections} />)
  renderer.drawFrame()
  const after = renderer.getFrameWorkCounters()
  const work = {
    painted: after.painted - before.painted,
    culledPainted: after.culledPainted - before.culledPainted,
    recorded: renderer.getRetainedCounters().builds - recorded,
  }
  const builtBefore = view.built()
  renderer.dispatchScrollWheel(320, 250, 0, 150)
  renderer.drawFrame()
  const scroll = { built: view.built() - builtBefore }
  view.finish(false)
  view.unmount()
  return { ...work, ...scroll }
}

describeNative("a dialog mounted with rows below its scroller's clip", () => {
  it("paints the band the scroller records past its clip, and culls the rows beyond it as without retention", () => {
    if (!process.env.GPUIX_RETAIN_OFF && !verifying) {
      const few = mount(12, true)
      const many = mount(24, true)
      const off = mount(24, false)
      expect(few.recorded, "the mounting frame records roots").toBeGreaterThan(0)
      expect(many.painted, "the elements painted do not grow with the rows below the band").toBe(few.painted)
      expect(many.culledPainted, "the rows beyond the band are culled").toBeGreaterThan(many.painted)
      expect(off.recorded).toBe(0)
      expect(many.painted, "the band is painted to be recorded, which the unrecorded mount does not").toBeGreaterThan(off.painted)
    }
  })

  it("replays the rows the first scroll brings in, from the band the mounting frame recorded", () => {
    if (!process.env.GPUIX_RETAIN_OFF && !verifying) {
      const recorded = mount(24, true)
      const built = mount(24, false)
      expect(recorded.built, "the first scroll builds a few elements").toBeLessThan(40)
      expect(built.built, "the same scroll with nothing recorded builds the whole page").toBeGreaterThan(recorded.built * 5)
    }
  })
})
