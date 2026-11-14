/**
 * Writing `scrollTop` lays out nothing, and a layout a read forces advances no animation (#70).
 *
 * In a browser a scroll offset is a paint property: the setter forces a layout only when one is
 * pending (a no-op when clean), clamps, and writes, so N writes in a task with nothing dirty run
 * no layout. Forced layout never runs animation frames either: the animation clock stands still
 * between frames. The cascade this guards against: a spring's `change` handler writes `scrollTop`,
 * the write made the next read lay out, the layout sampled the clock and advanced the spring,
 * its next `change` wrote again, 40 to 60 passes in a frame.
 *
 * The test window draws a dirty window whenever an update flushes, which would hide every pass,
 * so these tests turn that off (`setInlineDraws(false)`) and draw frames with `drawFrame`.
 */

import { useState } from "react"
import { describe, expect, it } from "vitest"
import { animate, useMotionValue, useMotionValueEvent } from "../index.js"
import type { MotionValue } from "../index.js"
import { flushSync } from "../reconciler/reconciler.js"
import type { PublicInstance } from "../types/host.js"
import type { TestRenderer } from "../testing.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { verifying } from "./retained-harness.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const WIDTH = 400
const HEIGHT = 300
const ROW = 36

function Rows(props: { count: number }) {
  return Array.from({ length: props.count }, (_, index) => (
    <div key={index} style={{ height: ROW, flexShrink: 0 }} />
  ))
}

/** A frame as the display link runs it: time passes, the events of the last draw are delivered, and
 *  a pending change is drawn once. */
function frame(renderer: TestRenderer, ms = 1000 / 60): void {
  renderer.clockFastForward(ms)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

function mount(node: React.ReactElement, options: { liveClock?: boolean } = {}) {
  const root = createTestRoot({ width: WIDTH, height: HEIGHT })
  if (!options.liveClock) root.renderer.clockPause()
  root.renderer.setInlineDraws(false)
  root.render(node)
  root.renderer.drawFrame()
  return root
}

describeNative("a scrollTop write", () => {
  it("lays out at most once a frame when a spring's change handler writes it", async () => {
    let position!: MotionValue<number>
    let scroller: PublicInstance | null = null
    let events = 0
    function Page() {
      position = useMotionValue(0)
      useMotionValueEvent(position, "change", (top) => {
        events++
        if (scroller !== null) scroller.scrollTop = top
      })
      return (
        <div
          ref={(instance) => {
            scroller = instance
          }}
          style={{ width: WIDTH, height: HEIGHT, overflowY: "scroll", flexDirection: "column" }}
        >
          <Rows count={400} />
        </div>
      )
    }
    // The clock runs, as it does under the display link: a layout that sampled it would move the spring.
    const { renderer, unmount } = mount(<Page />, { liveClock: true })
    try {
      let target = 0
      expect(scroller!.scrollTop).toBe(0)
      renderer.drawFrame()
      const layoutPasses = renderer.getLayoutPassCount()
      const passes = renderer.getLayoutCounters().passes
      const frames = 30
      for (let index = 0; index < frames; index++) {
        if (index % 2 === 0) {
          if (position.isAnimating()) position.stop()
          target += ROW * 2
          animate(position, target, { type: "spring", duration: 0.08, bounce: 0 })
        }
        renderer.dispatchNativeEvents()
        renderer.drawFrame()
        renderer.dispatchNativeEvents()
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
      expect(events, "the spring moved and its handler ran").toBeGreaterThan(10)
      expect(scroller!.scrollTop, "and the scroller followed").toBeGreaterThan(ROW * 2)
      expect(renderer.getLayoutPassCount() - layoutPasses, "no layout-only pass").toBe(0)
      // A verified frame builds the page a second time, whole, and that build is a pass of its own.
      if (!verifying) expect(renderer.getLayoutCounters().passes - passes, "the draws' own").toBeLessThanOrEqual(frames)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("runs no layout for any number of writes when nothing is dirty, and clamps each", () => {
    let scroller: PublicInstance | null = null
    const { renderer, unmount } = mount(
      <div
        ref={(instance) => {
          scroller = instance
        }}
        style={{ width: WIDTH, height: HEIGHT, overflowY: "scroll", flexDirection: "column" }}
      >
        <Rows count={25} />
      </div>
    )
    try {
      const max = 25 * ROW - HEIGHT
      expect(scroller!.scrollTop).toBe(0)
      const layoutPasses = renderer.getLayoutPassCount()
      const passes = renderer.getLayoutCounters().passes
      const painted = renderer.getPaintedFrameCount()
      for (let index = 1; index <= 50; index++) {
        scroller!.scrollTop = index * 100
        scroller!.scrollLeft = 0
      }
      expect(scroller!.scrollTop, "clamped to the largest offset").toBe(max)
      expect(scroller!.scrollHeight - scroller!.clientHeight).toBe(max)
      scroller!.scrollTop = -20
      expect(scroller!.scrollTop, "and to the start").toBe(0)
      expect(renderer.getLayoutPassCount() - layoutPasses).toBe(0)
      expect(renderer.getLayoutCounters().passes - passes).toBe(0)
      expect(renderer.getPaintedFrameCount() - painted, "a write draws nothing itself").toBe(0)

      scroller!.scrollTop = 100
      renderer.drawFrame()
      expect(renderer.getPaintedFrameCount() - painted, "the frame still redraws").toBe(1)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("lays out once after a style change in the same task and clamps against the new extent", () => {
    let scroller: PublicInstance | null = null
    let setCount!: (count: number) => void
    function Page() {
      const [count, set] = useState(25)
      setCount = set
      return (
        <div
          ref={(instance) => {
            scroller = instance
          }}
          style={{ width: WIDTH, height: HEIGHT, overflowY: "scroll", flexDirection: "column" }}
        >
          <Rows count={count} />
        </div>
      )
    }
    const { renderer, unmount } = mount(<Page />)
    try {
      expect(scroller!.scrollTop).toBe(0)
      const layoutPasses = renderer.getLayoutPassCount()

      flushSync(() => setCount(100))
      scroller!.scrollTop = 1e6

      expect(scroller!.scrollTop, "the content grew before the write was clamped").toBe(100 * ROW - HEIGHT)
      expect(renderer.getLayoutPassCount() - layoutPasses, "one layout for the change").toBe(1)
      scroller!.scrollTop = 500
      scroller!.scrollTop = 1e6
      expect(renderer.getLayoutPassCount() - layoutPasses, "and none for the writes after it").toBe(1)

      flushSync(() => setCount(10))
      expect(scroller!.scrollTop, "content that shrinks pulls the offset back").toBe(Math.max(0, 10 * ROW - HEIGHT))
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("moves what a bounds read sees", () => {
    let scroller: PublicInstance | null = null
    let child: PublicInstance | null = null
    const { renderer, unmount } = mount(
      <div
        ref={(instance) => {
          scroller = instance
        }}
        style={{ width: WIDTH, height: HEIGHT, overflowY: "scroll", flexDirection: "column" }}
      >
        <Rows count={5} />
        <div
          ref={(instance) => {
            child = instance
          }}
          style={{ height: ROW, flexShrink: 0 }}
        />
        <Rows count={20} />
      </div>
    )
    try {
      const top = child!.getBoundingClientRect().top
      renderer.drawFrame()
      const layoutPasses = renderer.getLayoutPassCount()

      scroller!.scrollTop = 120
      expect(renderer.getLayoutPassCount() - layoutPasses, "the write lays out nothing").toBe(0)
      expect(child!.getBoundingClientRect().top, "a bounds read sees the scrolled position").toBe(top - 120)
      expect(renderer.getLayoutPassCount() - layoutPasses, "and lays out for it, once").toBe(1)
      scroller!.scrollTop = 150
      expect(child!.getBoundingClientRect().top).toBe(top - 150)
      expect(renderer.getLayoutPassCount() - layoutPasses).toBe(2)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })
})

function ListRows(props: { count: number; from?: number }) {
  return Array.from({ length: props.count }, (_, index) => {
    const row = (props.from ?? 0) + index
    return (
      <div key={row} testId={`row-${row}`} style={{ height: ROW, flexShrink: 0 }}>
        {`row-${row};`}
      </div>
    )
  })
}

describeNative("a scrollTop write on a virtual-list", () => {
  const listStyle = { width: WIDTH, height: HEIGHT }

  it("runs no layout when nothing is dirty, clamps to the rows and moves nothing it reads", () => {
    let list: PublicInstance | null = null
    const { renderer, unmount } = mount(
      <virtual-list
        ref={(instance: PublicInstance | null) => {
          list = instance
        }}
        overdraw={0}
        estimatedItemHeight={ROW}
        style={listStyle}
      >
        <ListRows count={100} />
      </virtual-list>
    )
    try {
      const max = 100 * ROW - HEIGHT
      expect(list!.scrollTop).toBe(0)
      const layoutPasses = renderer.getLayoutPassCount()
      const passes = renderer.getLayoutCounters().passes
      const painted = renderer.getPaintedFrameCount()
      for (let index = 1; index <= 50; index++) list!.scrollTop = index * 100
      expect(list!.scrollTop, "clamped to the last row").toBe(max)
      expect(list!.scrollHeight - list!.clientHeight).toBe(max)
      list!.scrollTop = -20
      expect(list!.scrollTop, "and to the start").toBe(0)
      list!.scrollTop = 1000
      expect(list!.scrollTop, "a write reads back").toBe(1000)
      expect(renderer.getLayoutPassCount() - layoutPasses).toBe(0)
      expect(renderer.getLayoutCounters().passes - passes).toBe(0)
      expect(renderer.getPaintedFrameCount() - painted, "a write draws nothing itself").toBe(0)

      renderer.drawFrame()
      expect(renderer.getPaintedFrameCount() - painted, "the frame redraws").toBe(1)
      expect(list!.scrollTop, "and keeps the offset").toBe(1000)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("lays out once when something else is dirty, and clamps against the rows it lays out", () => {
    let list: PublicInstance | null = null
    let setCount!: (count: number) => void
    function Page() {
      const [count, set] = useState(100)
      setCount = set
      return (
        <virtual-list
          ref={(instance: PublicInstance | null) => {
            list = instance
          }}
          overdraw={0}
          estimatedItemHeight={ROW}
          style={listStyle}
        >
          <ListRows count={count} />
        </virtual-list>
      )
    }
    const { renderer, unmount } = mount(<Page />)
    try {
      expect(list!.scrollTop).toBe(0)
      const layoutPasses = renderer.getLayoutPassCount()

      flushSync(() => setCount(200))
      list!.scrollTop = 1e6
      expect(list!.scrollTop, "the rows grew before the write was clamped").toBe(200 * ROW - HEIGHT)
      expect(renderer.getLayoutPassCount() - layoutPasses, "one layout for the change").toBe(1)
      list!.scrollTop = 500
      list!.scrollTop = 1e6
      expect(renderer.getLayoutPassCount() - layoutPasses, "and none for the writes after it").toBe(1)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("is applied to a list that was never drawn", () => {
    const root = createTestRoot({ width: WIDTH, height: HEIGHT })
    root.renderer.clockPause()
    root.renderer.setInlineDraws(false)
    let list: PublicInstance | null = null
    try {
      root.render(
        <virtual-list
          ref={(instance: PublicInstance | null) => {
            list = instance
          }}
          overdraw={0}
          estimatedItemHeight={ROW}
          style={listStyle}
        >
          <ListRows count={100} />
        </virtual-list>
      )
      list!.scrollTop = 20 * ROW
      expect(list!.scrollTop).toBe(20 * ROW)
      root.renderer.drawFrame()
      expect(root.renderer.getPaintedText()).toContain("row-20;")
      expect(root.renderer.getPaintedText()).not.toContain("row-0;")
    } finally {
      root.renderer.setInlineDraws(true)
      root.unmount()
    }
  })

  it("moves what a bounds read sees and what the frame draws", () => {
    let list: PublicInstance | null = null
    let row: PublicInstance | null = null
    const { renderer, unmount } = mount(
      <virtual-list
        ref={(instance: PublicInstance | null) => {
          list = instance
        }}
        overdraw={0}
        estimatedItemHeight={ROW}
        style={listStyle}
      >
        <ListRows count={5} />
        <div
          ref={(instance) => {
            row = instance
          }}
          testId="row-5"
          style={{ height: ROW, flexShrink: 0 }}
        >
          row-5;
        </div>
        <ListRows from={6} count={94} />
      </virtual-list>
    )
    try {
      const top = row!.getBoundingClientRect().top
      renderer.drawFrame()
      const layoutPasses = renderer.getLayoutPassCount()

      list!.scrollTop = 120
      expect(renderer.getLayoutPassCount() - layoutPasses, "the write lays out nothing").toBe(0)
      expect(row!.getBoundingClientRect().top, "a bounds read sees the rows at the new offset").toBe(top - 120)
      expect(renderer.getLayoutPassCount() - layoutPasses, "and lays out for it, once").toBe(1)

      list!.scrollTop = 30 * ROW
      expect(renderer.getElementBounds(renderer.findByTestId("row-31")!.id).y, "rows that did not exist are there").toBe(ROW)
      renderer.drawFrame()
      const text = renderer.getPaintedText()
      expect(text).toContain("row-30;")
      expect(text).not.toContain("row-5;")
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })
})

describeNative("a layout pass a read forces", () => {
  it("advances no motion value and fires no change event", () => {
    let width!: MotionValue<number>
    const events: number[] = []
    function Page() {
      width = useMotionValue(10)
      useMotionValueEvent(width, "change", (value) => events.push(value))
      return (
        <div style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <div testId="box" style={{ width, height: 20 }} />
        </div>
      )
    }
    const { renderer, unmount } = mount(<Page />)
    try {
      const boxWidth = () => renderer.getElementBounds(renderer.findByTestId("box").id).width
      animate(width, 210, { duration: 1, ease: "linear" })
      frame(renderer, 100)
      renderer.dispatchNativeEvents()
      const drawn = boxWidth()
      expect(drawn, "the frame advanced it").toBeGreaterThan(10)
      const delivered = events.length
      expect(delivered, "and told JS").toBeGreaterThan(0)

      // Time passes and something dirties the window: the read lays out, but only a draw samples.
      const layoutPasses = renderer.getLayoutPassCount()
      renderer.clockFastForward(400)
      renderer.flush()
      expect(boxWidth(), "the layout shows the last frame's value").toBe(drawn)
      expect(renderer.getLayoutPassCount() - layoutPasses, "and it did lay out").toBe(1)
      renderer.dispatchNativeEvents()
      expect(events.length, "and fired nothing").toBe(delivered)

      renderer.drawFrame()
      renderer.dispatchNativeEvents()
      expect(boxWidth(), "the next draw takes the time").toBeGreaterThan(drawn + 50)
      expect(events.length).toBeGreaterThan(delivered)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })
})

/** What a page whose content changes in the same task as the writes holds: the scroller or list, a way to
 *  change its row count, and its row count's bearing on the largest offset. */
function ScrollerPage(props: { list: boolean; page: { setCount: (count: number) => void; target: PublicInstance | null } }) {
  const [count, setCount] = useState(25)
  props.page.setCount = setCount
  const ref = (instance: PublicInstance | null) => {
    props.page.target = instance
  }
  return props.list ? (
    <virtual-list ref={ref} overdraw={0} estimatedItemHeight={ROW} style={{ width: WIDTH, height: HEIGHT }}>
      <ListRows count={count} />
    </virtual-list>
  ) : (
    <div ref={ref} style={{ width: WIDTH, height: HEIGHT, overflowY: "scroll", flexDirection: "column" }}>
      <Rows count={count} />
    </div>
  )
}

describeNative.each([{ list: false }, { list: true }])("scroll writes while the layout is behind the tree (list: $list)", (variant) => {
  function open() {
    const page = { setCount: (_count: number) => {}, target: null as PublicInstance | null }
    const mounted = mount(<ScrollerPage list={variant.list} page={page} />)
    return { ...mounted, page }
  }

  it("lays out nothing for any number of writes to the start, and the frame after them lays out once", () => {
    const { renderer, unmount, page } = open()
    try {
      page.target!.scrollTop = 5 * ROW
      renderer.drawFrame()
      const layoutPasses = renderer.getLayoutPassCount()
      const passes = renderer.getLayoutCounters().passes
      const painted = renderer.getPaintedFrameCount()

      flushSync(() => page.setCount(100))
      for (let index = 0; index < 5; index++) {
        page.target!.scrollTo({ top: 0 })
        page.target!.scrollTop = 0
        page.target!.scrollLeft = 0
        page.target!.scrollTo({ left: 0 })
        page.target!.scrollTo(0, 0)
      }
      expect(renderer.getLayoutPassCount() - layoutPasses, "no layout-only pass").toBe(0)
      expect(renderer.getLayoutCounters().passes - passes, "no pass at all").toBe(0)
      expect(renderer.getPaintedFrameCount() - painted, "no frame").toBe(0)

      renderer.drawFrame()
      expect(renderer.getPaintedFrameCount() - painted, "one frame follows").toBe(1)
      expect(renderer.getLayoutPassCount() - layoutPasses, "which is not a layout-only pass").toBe(0)
      // A verified frame builds the page a second time, whole, and that build is a pass of its own.
      if (!verifying) expect(renderer.getLayoutCounters().passes - passes, "and has the one layout").toBe(1)
      expect(page.target!.scrollTop, "the scroller is at the start").toBe(0)
      expect(renderer.getLayoutPassCount() - layoutPasses, "the read after the frame lays out nothing").toBe(0)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("lays out once for the first write of a div to another position, and not for the writes after it", () => {
    const { renderer, unmount, page } = open()
    try {
      renderer.drawFrame()
      expect(page.target!.scrollTop).toBe(0)
      const layoutPasses = renderer.getLayoutPassCount()
      const painted = renderer.getPaintedFrameCount()

      flushSync(() => page.setCount(100))
      page.target!.scrollTop = 1e6
      // A list has no anchoring: it is written again when the frame has spliced its rows.
      const first = variant.list ? 0 : 1
      expect(renderer.getLayoutPassCount() - layoutPasses, "the layout scroll anchoring needs before the write").toBe(first)
      for (let index = 0; index < 5; index++) {
        page.target!.scrollTo({ top: 200 + index * ROW })
        page.target!.scrollTop = 400 + index * ROW
      }
      expect(renderer.getLayoutPassCount() - layoutPasses, "and none for the writes after it").toBe(first)
      expect(renderer.getPaintedFrameCount() - painted, "no frame yet").toBe(0)
      renderer.drawFrame()
      expect(renderer.getPaintedFrameCount() - painted, "one frame follows").toBe(1)
      expect(page.target!.scrollTop).toBe(400 + 4 * ROW)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("reads the clamped value after content that grew and shrank in the same task", () => {
    const { renderer, unmount, page } = open()
    try {
      renderer.drawFrame()
      const layoutPasses = renderer.getLayoutPassCount()

      flushSync(() => page.setCount(200))
      page.target!.scrollTop = 1e6
      expect(page.target!.scrollTop, "clamped to the rows that grew").toBe(200 * ROW - HEIGHT)
      expect(renderer.getLayoutPassCount() - layoutPasses, "the read laid out for the change").toBe(1)

      flushSync(() => page.setCount(10))
      page.target!.scrollTop = 1e6
      expect(page.target!.scrollTop, "and to the rows that shrank").toBe(10 * ROW - HEIGHT)

      flushSync(() => page.setCount(300))
      flushSync(() => page.setCount(30))
      page.target!.scrollTop = 1e6
      expect(page.target!.scrollTop, "grown and shrunk before the write").toBe(30 * ROW - HEIGHT)
      page.target!.scrollTop = -20
      expect(page.target!.scrollTop, "below the start").toBe(0)

      flushSync(() => page.setCount(100))
      page.target!.scrollTop = 17 * ROW
      expect(page.target!.scrollTop, "inside the range").toBe(17 * ROW)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("serves every read from the last layout when nothing is dirty", () => {
    const { renderer, unmount, page } = open()
    try {
      // The test renderer applies the first read's mutations when it is made, which is a pass the
      // live window has had by the time of its first frame.
      expect(page.target!.scrollTop).toBe(0)
      renderer.drawFrame()
      const layoutPasses = renderer.getLayoutPassCount()
      const passes = renderer.getLayoutCounters().passes
      const painted = renderer.getPaintedFrameCount()
      for (let index = 0; index < 5; index++) {
        expect(page.target!.scrollTop).toBe(0)
        expect(page.target!.scrollLeft).toBe(0)
        expect(page.target!.clientHeight).toBe(HEIGHT)
        expect(page.target!.scrollHeight).toBe(25 * ROW)
      }
      page.target!.scrollTop = 3 * ROW
      expect(page.target!.scrollTop, "a write then a read").toBe(3 * ROW)
      page.target!.scrollTo({ top: 1e6 })
      expect(page.target!.scrollTop, "clamped").toBe(25 * ROW - HEIGHT)
      page.target!.scrollBy({ top: -ROW })
      expect(page.target!.scrollTop, "a relative write reads first, and still lays out nothing").toBe(25 * ROW - HEIGHT - ROW)
      expect(renderer.getLayoutPassCount() - layoutPasses).toBe(0)
      expect(renderer.getLayoutCounters().passes - passes).toBe(0)
      expect(renderer.getPaintedFrameCount() - painted).toBe(0)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })
})

describeNative("a scroll write to a list while the layout is behind the tree", () => {
  it("lands at the logical position a write after a frame lands at", () => {
    let list: PublicInstance | null = null
    let setCount!: (count: number) => void
    function Page() {
      const [count, set] = useState(100)
      setCount = set
      return (
        <virtual-list
          ref={(instance: PublicInstance | null) => {
            list = instance
          }}
          overdraw={0}
          estimatedItemHeight={ROW}
          style={{ width: WIDTH, height: HEIGHT }}
        >
          <ListRows count={count} />
        </virtual-list>
      )
    }
    const { renderer, unmount } = mount(<Page />)
    try {
      const listId = renderer.findByType("virtual-list")[0]!.id
      // Both orders end at the position a write that came after the layout gives.
      const landing = (top: number, behind: boolean) => {
        flushSync(() => setCount(100))
        list!.scrollTop = 0
        renderer.drawFrame()
        flushSync(() => setCount(200))
        if (!behind) renderer.drawFrame()
        list!.scrollTo({ top })
        renderer.drawFrame()
        return renderer.getListScrollTop(listId)
      }
      for (const top of [0, 1000, 17 * ROW + 5, 150 * ROW, 1e6]) {
        expect(landing(top, true), `a write to ${top} in the task of the change`).toEqual(landing(top, false))
      }
      flushSync(() => setCount(100))
      list!.scrollTop = 0
      renderer.drawFrame()
      list!.scrollTop = 1000
      renderer.drawFrame()
      expect(renderer.getListScrollTop(listId), "row 27, 28 px into it").toEqual([27, 28, HEIGHT])

      flushSync(() => setCount(200))
      list!.scrollTop = 500
      renderer.scrollToItem(listId, 60, 0)
      renderer.drawFrame()
      expect(renderer.getListScrollTop(listId), "the later write, a row").toEqual([60, 0, HEIGHT])
      flushSync(() => setCount(201))
      renderer.scrollToItem(listId, 80, 0)
      list!.scrollTop = 40 * ROW
      renderer.drawFrame()
      expect(renderer.getListScrollTop(listId), "the later write, a pixel position").toEqual([40, 0, HEIGHT])
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })
})

describeNative("a scrollTop write after a commit inside the scroller and a restyle that only paints", () => {
  it("lays out first for the commit, as a write after the commit alone does", () => {
    let scroller: PublicInstance | null = null
    let setGrown!: (grown: boolean) => void
    let setTinted!: (tinted: boolean) => void
    function Page() {
      const [grown, grow] = useState(false)
      const [tinted, tint] = useState(false)
      setGrown = grow
      setTinted = tint
      return (
        <div style={{ width: WIDTH, height: HEIGHT, display: "flex", flexDirection: "column" }}>
          <div
            style={{
              width: 40,
              height: 20,
              flexShrink: 0,
              backgroundColor: tinted ? "#ff0000" : "#0000ff",
              transition: "background-color 1s linear",
            }}
          />
          <div
            ref={(instance) => {
              scroller = instance
            }}
            style={{ height: 200, overflowY: "scroll", display: "flex", flexDirection: "column" }}
          >
            <div style={{ height: grown ? 800 : ROW, flexShrink: 0 }} />
            <Rows count={24} />
          </div>
        </div>
      )
    }
    const root = createTestRoot({ width: WIDTH, height: HEIGHT })
    const renderer = root.renderer
    const unmount = () => root.unmount()
    renderer.clockPause()
    renderer.setInlineDraws(false)
    // The scroller is an anchor of the patch frames only where the retention records its frame: planning on, and the gate open,
    // which the verifier forces whatever the run's environment says.
    renderer.setRetainPlanning(true)
    renderer.setRetainVerify(true)
    renderer.setPatchEnabled(true)
    try {
      root.render(<Page />)
      renderer.drawFrame()
      expect(scroller!.scrollTop).toBe(0)

      // The commit lies inside an anchor, so it counts no layout invalidation and waits for a read to prepare its patch; the
      // restyle after it paints only, and must not take that wait away.
      flushSync(() => setGrown(true))
      // A live window invalidates for every batch; the test window does it when something reads, and merges the batches before.
      renderer["native"].flushIfDirty()
      flushSync(() => setTinted(true))
      scroller!.scrollTop = 1000
      // Past the old extent and inside the new one; scroll anchoring would carry it to the end if the write came before the layout.
      expect(scroller!.scrollTop).toBe(1000)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })
})

describeNative("a scrollTop write after a wheel", () => {
  // A wheel is a scroll write to gpui: the scroll metrics stay current, so the write that comes
  // before the next frame is clamped at once, as one with nothing dirty is.
  function mountScrollers() {
    const scrollers: Record<"a" | "b", PublicInstance | null> = { a: null, b: null }
    const column = (name: "a" | "b") => (
      <div
        ref={(instance) => {
          scrollers[name] = instance
        }}
        style={{ width: WIDTH / 2, height: HEIGHT, overflowY: "scroll", flexDirection: "column" }}
      >
        <Rows count={60} />
      </div>
    )
    const root = mount(
      <div style={{ width: WIDTH, height: HEIGHT, display: "flex", flexDirection: "row" }}>
        {column("a")}
        {column("b")}
      </div>
    )
    return { ...root, scrollers: scrollers as Record<"a" | "b", PublicInstance> }
  }

  it("holds a scrollTop written before the next frame, and reads it back", () => {
    const { renderer, scrollers, unmount } = mountScrollers()
    try {
      renderer.nativeSimulateScrollWheel(50, 50, 0, 50)
      expect(scrollers.a.scrollTop).toBe(50)
      const layoutPasses = renderer.getLayoutPassCount()

      scrollers.a.scrollTop = 300
      expect(scrollers.a.scrollTop, "the write was made, not recorded for the next layout").toBe(300)
      expect(renderer.getLayoutPassCount() - layoutPasses, "and laid out nothing").toBe(0)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("moves by both of two scrollBy calls of one handler", () => {
    const { renderer, scrollers, unmount } = mountScrollers()
    try {
      renderer.nativeSimulateScrollWheel(50, 50, 0, 50)
      scrollers.a.scrollBy(0, 100)
      scrollers.a.scrollBy(0, 100)
      expect(scrollers.a.scrollTop).toBe(250)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("holds a write to a second scroller after a wheel on the first", () => {
    const { renderer, scrollers, unmount } = mountScrollers()
    try {
      renderer.nativeSimulateScrollWheel(50, 50, 0, 50)
      scrollers.b.scrollTop = 400
      expect(scrollers.b.scrollTop).toBe(400)
      expect(scrollers.a.scrollTop, "the scroller the wheel moved stays where it is").toBe(50)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("holds a write to a virtual-list after a wheel on it, with no layout pass", () => {
    let list: PublicInstance | null = null
    const { renderer, unmount } = mount(
      <virtual-list
        ref={(instance: PublicInstance | null) => {
          list = instance
        }}
        overdraw={0}
        estimatedItemHeight={ROW}
        style={{ width: WIDTH, height: HEIGHT }}
      >
        <ListRows count={100} />
      </virtual-list>
    )
    try {
      renderer.nativeSimulateScrollWheel(50, 50, 0, 50)
      expect(list!.scrollTop).toBeGreaterThan(0)
      const layoutPasses = renderer.getLayoutPassCount()
      list!.scrollTop = 600
      list!.scrollTop = 900
      expect(list!.scrollTop).toBe(900)
      expect(renderer.getLayoutPassCount() - layoutPasses).toBe(0)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })

  it("still lays out for a write after the content changed since the wheel, and clamps it", () => {
    let setCount!: (count: number) => void
    let scroller: PublicInstance | null = null
    function Page() {
      const [count, set] = useState(25)
      setCount = set
      return (
        <div
          ref={(instance) => {
            scroller = instance
          }}
          style={{ width: WIDTH, height: HEIGHT, overflowY: "scroll", flexDirection: "column" }}
        >
          <Rows count={count} />
        </div>
      )
    }
    const { renderer, unmount } = mount(<Page />)
    try {
      renderer.nativeSimulateScrollWheel(50, 50, 0, 50)
      flushSync(() => setCount(100))
      scroller!.scrollTop = 1e6
      expect(scroller!.scrollTop).toBe(100 * ROW - HEIGHT)
    } finally {
      renderer.setInlineDraws(true)
      unmount()
    }
  })
})
