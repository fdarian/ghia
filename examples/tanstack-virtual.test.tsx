/**
 * @tanstack/solid-virtual (virtual-core 3.19) driving a list on Ghia without an adapter:
 * a wheel scroll must paint rows over the whole viewport in the first frame that paints the new offset.
 */
import { createTestRoot, hasNativeTestRenderer, type TestRenderer } from '@ghia/solid/testing'
import { createComponent } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { App } from './solid/tanstack-virtual/App'
import { MeasuredApp, measuredRowHeight } from './solid/tanstack-virtual/MeasuredApp'
import { makeMessages } from './solid/tanstack-virtual/messages'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const ROW_HEIGHT = 72
const messages = makeMessages(2_000)

/** A component is created with `createComponent`, as JSX does: called as a function, what it reads would subscribe the root. */
function mount(component: () => unknown) {
  const app = createTestRoot({ width: 420, height: 800 })
  const renderer = app.renderer
  renderer.clockPause()
  renderer.setInlineDraws(false)
  app.render(component as never)
  renderer.drawFrame()
  renderer.dispatchNativeEvents()
  renderer.flush()
  renderer.drawFrame()
  const list = renderer.findByTestId('list')!.id
  return { ...app, list }
}

function rowBoxes(renderer: TestRenderer) {
  const children = renderer.findByTestId('list-inner')!.children
  expect(children, 'the list is mounted inside its inner div').not.toHaveLength(0)
  return children.map((id) => renderer.getElementBounds(id)!)
}

/** The rows' boxes, in the window, cover the list's box from top to bottom with no gap. */
function expectCovered(renderer: TestRenderer, list: number) {
  const viewport = renderer.getElementBounds(list)!
  const rows = rowBoxes(renderer)
    .map((box) => ({ top: box.y, bottom: box.y + box.height }))
    .sort((a, b) => a.top - b.top)
  let covered = viewport.y
  for (const row of rows) {
    if (row.top > covered + 0.5) break
    covered = Math.max(covered, row.bottom)
  }
  expect(covered, 'the rows reach the bottom of the viewport').toBeGreaterThanOrEqual(viewport.y + viewport.height - 0.5)
  expect(rows[0].top, 'a row starts at or above the top of the viewport').toBeLessThanOrEqual(viewport.y + 0.5)
}

/** What the frame that is drawn next paints, and the number of draws it took. */
function nextFrame(renderer: TestRenderer) {
  const before = renderer.getPaintedFrameCount()
  renderer.drawFrame()
  const painted = renderer.getPaintedText()
  return { painted, frames: renderer.getPaintedFrameCount() - before }
}

describeNative('@tanstack/solid-virtual list', () => {
  for (const rows of [1, 3, 10]) {
    it(`has rows over the whole viewport in the first frame that paints a wheel scroll of ${rows} rows`, () => {
      const app = mount(() => createComponent(App, { messages }))
      const renderer = app.renderer
      try {
        const viewport = renderer.getElementBounds(app.list)!
        expect(renderer.getScrollOffset(app.list)![1]).toBe(0)
        expectCovered(renderer, app.list)

        renderer.nativeSimulateScrollWheel(viewport.x + 100, viewport.y + 100, 0, rows * ROW_HEIGHT)
        const frame = nextFrame(renderer)
        expect(frame.frames).toBe(1)
        expect(renderer.getScrollOffset(app.list)![1]).toBe(rows * ROW_HEIGHT)

        // The rows painted in that frame, by the subject each shows, are those under the viewport.
        const first = rows
        const last = Math.floor((rows * ROW_HEIGHT + viewport.height - 1) / ROW_HEIGHT)
        for (let index = first; index <= last; index++) {
          expect(
            frame.painted.some((text) => text.includes(`#${index}`)),
            `row ${index} is painted by the frame that paints offset ${rows * ROW_HEIGHT}`,
          ).toBe(true)
        }
        expectCovered(renderer, app.list)
      } finally {
        app.unmount()
      }
    })
  }

  it('scrolls to an index with the keyboard, which is scrollToIndex and its requestAnimationFrame reconcile', () => {
    const app = mount(() => createComponent(App, { messages }))
    const renderer = app.renderer
    try {
      const viewport = renderer.getElementBounds(app.list)!
      for (let press = 0; press < 20; press++) renderer.simulateKeystrokes('ArrowDown')
      for (let frame = 0; frame < 4; frame++) {
        renderer.clockFastForward(20)
        nextFrame(renderer)
      }
      const top = renderer.getScrollOffset(app.list)![1]
      const row = 20
      expect(top).toBeGreaterThan(0)
      expect(row * ROW_HEIGHT).toBeGreaterThanOrEqual(top)
      expect((row + 1) * ROW_HEIGHT).toBeLessThanOrEqual(top + viewport.height + 0.5)
      expectCovered(renderer, app.list)
    } finally {
      app.unmount()
    }
  })

  it('renders again when a filter changes the count', async () => {
    const app = mount(() => createComponent(App, { messages }))
    const renderer = app.renderer
    try {
      expect(renderer.getAllText().join(' ')).toMatch(/2,000\s+conversations/)
      let typed = ''
      for (const key of ['7', '1']) {
        typed += key
        renderer.simulateKeystrokes(key)
        // Solid sends the mutations of a write in a microtask.
        await Promise.resolve()
        renderer.drawFrame()
        renderer.dispatchNativeEvents()
        renderer.flush()
        renderer.drawFrame()
        const count = messages.filter((m) => `${m.fromName} ${m.subject} ${m.snippet}`.toLowerCase().includes(typed)).length
        const format = new Intl.NumberFormat('en-US')
        expect(renderer.getAllText().join(' '), `after typing ${typed}`).toMatch(new RegExp(`${format.format(count)}\\s+conversations`))
        expect(renderer.getElementBounds(renderer.findByTestId('list-inner')!.id)!.height).toBe(count * ROW_HEIGHT)
        expectCovered(renderer, app.list)
      }
    } finally {
      app.unmount()
    }
  })

  it('lays measured rows out at their measured heights', async () => {
    const app = mount(() => createComponent(MeasuredApp, { messages }))
    const renderer = app.renderer
    try {
      // The `ref` measures in a microtask, the ResizeObserver reports in the sweep after the draw, and the
      // sizes it measured move the rows below in the frame after.
      for (let frame = 0; frame < 6; frame++) {
        await Promise.resolve()
        renderer.dispatchNativeEvents()
        renderer.flush()
        renderer.drawFrame()
      }
      const boxes = rowBoxes(renderer)
      const ids = renderer.findByTestId('list-inner')!.children
      expect(ids.length).toBeGreaterThan(5)
      let expectedTop = 0
      const viewport = renderer.getElementBounds(app.list)!
      ids.forEach((_, position) => {
        const message = messages[position]
        expect(boxes[position].height, `row ${position} has its measured height`).toBe(measuredRowHeight(message))
        expect(boxes[position].y - viewport.y).toBe(expectedTop)
        expectedTop += measuredRowHeight(message)
      })
      // The scroll height is the measured rows plus the estimate of the unmeasured ones.
      const inner = renderer.getElementBounds(renderer.findByTestId('list-inner')!.id)!
      expect(inner.height).toBeGreaterThan(expectedTop)
    } finally {
      app.unmount()
    }
  })
})
