/**
 * An idle `layout` box beside a loop elsewhere (issue #117). One looping opacity animation over a page of
 * cards, and a `motion.div` with `layout`, `layout="position"` or `layout="size"` that never moves. A
 * tick of the loop is patched when the page has no such box; it was drawn whole when it had one, because
 * the box was counted as an element that follows the clock (`Unsteady`) and a page with a box in it
 * that nothing could skip was not recorded at all (`NoFrame`).
 *
 * The guard is on what a tick was (patched or whole, from `getPatchCounters`), not on a clock, and on the cost
 * of a tick against the page with no box, which the bug made several times higher. Run it through
 * `bun run test:perf:layout-idle` (NODE_ENV=production, like `test:perf`).
 */

import React from 'react'
import { describe, expect, it } from 'vitest'
import { motion, Reorder } from '@ghia/react'
import { createTestRoot, hasNativeTestRenderer } from '@ghia/react/testing'
import { sample, summarize } from './perf-harness'
import { C, CardGrid } from './perf-fixtures'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const WINDOW = { width: 1240, height: 780 }
const SETTLE = 60
const TICKS = 150
const patching = process.env.GPUIX_RETAIN_OFF === undefined && process.env.GPUIX_PATCH_OFF === undefined

type Variant = 'none' | 'position' | 'layout' | 'size' | 'drag'

function Page({ variant }: { variant: Variant }) {
  return (
    <div style={{ width: WINDOW.width, height: WINDOW.height, backgroundColor: C.bg, overflow: 'hidden' }}>
      <motion.div
        animate={{ opacity: [1, 0.4, 1] }}
        transition={{ duration: 1, repeat: Number.POSITIVE_INFINITY }}
        style={{ width: 40, height: 40, backgroundColor: '#6B97FF' }}
      />
      {variant === 'drag' ? (
        <Reorder.Group axis="y" values={['a']} onReorder={() => {}}>
          <Reorder.Item value="a" testId="held" style={{ width: 120, height: 24, backgroundColor: '#999999' }} />
        </Reorder.Group>
      ) : (
        <motion.div
          layout={variant === 'none' ? undefined : variant === 'layout' ? true : variant}
          style={{ width: 120, height: 24, backgroundColor: '#999999' }}
        />
      )}
      <CardGrid cards={30} />
    </div>
  )
}

function ticksOf(renderer: ReturnType<typeof createTestRoot>['renderer'], count: number) {
  const patchedBefore = renderer.getPatchCounters().patchedFrames
  const wholeBefore = renderer.getPaintedFrameCount()
  const cost = summarize(
    sample(
      () => {
        renderer.clockAdvance(16)
        renderer.dispatchNativeEvents()
        renderer.drawFrame()
      },
      0,
      count,
    ),
  )
  return {
    patched: renderer.getPatchCounters().patchedFrames - patchedBefore,
    whole: renderer.getPaintedFrameCount() - wholeBefore,
    cpuP50: cost.cpuP50,
  }
}

describeNative('an idle layout box beside a loop', () => {
  const costs: Partial<Record<Variant, number>> = {}
  for (const variant of ['none', 'position', 'layout', 'size', 'drag'] as const) {
    it(`${variant}: every tick of the loop is patched`, () => {
      const root = createTestRoot(WINDOW)
      try {
        root.render(<Page variant={variant} />)
        const renderer = root.renderer
        renderer.flush()
        ticksOf(renderer, SETTLE)
        const run = ticksOf(renderer, TICKS)
        costs[variant] = run.cpuP50
        console.log(`[layout-idle.perf] ${variant} patched=${run.patched} whole=${run.whole} tick=${run.cpuP50.toFixed(3)}ms`)
        if (patching) {
          expect(run.patched).toBe(TICKS)
          expect(run.whole).toBe(0)
        }
      } finally {
        root.unmount()
      }
    }, 120_000)
  }

  it('a tick beside an idle layout box costs about what it does beside none', () => {
    if (!patching) return
    const none = costs.none
    expect(none).toBeDefined()
    for (const variant of ['position', 'layout', 'size', 'drag'] as const) {
      expect(costs[variant], variant).toBeDefined()
      // Whole frames of this page cost several times a patched tick; the bound leaves room for a noisy machine.
      expect(costs[variant]!, variant).toBeLessThan(none! * 2.5 + 0.2)
    }
  })

  it('drag: ticks are whole while the box is held and patched again after it has glided back', () => {
    const root = createTestRoot(WINDOW)
    try {
      root.render(<Page variant="drag" />)
      const renderer = root.renderer
      renderer.flush()
      ticksOf(renderer, SETTLE)
      const box = renderer.getElementBounds(renderer.findByTestId('held').id)
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      renderer.nativeSimulateMouseDown(x, y)
      renderer.nativeSimulateMouseMove(x, y + 8)
      renderer.drawFrame()
      const held = ticksOf(renderer, TICKS)
      renderer.nativeSimulateMouseUp(x, y + 8, 0)
      renderer.drawFrame()
      ticksOf(renderer, 90)
      const after = ticksOf(renderer, TICKS)
      console.log(
        `[layout-idle.perf] drag held patched=${held.patched} whole=${held.whole} tick=${held.cpuP50.toFixed(3)}ms; ` +
          `after patched=${after.patched} whole=${after.whole}`,
      )
      if (patching) {
        expect(held.patched).toBe(0)
        expect(held.whole).toBe(TICKS)
        expect(after.patched).toBeGreaterThanOrEqual(TICKS - 3)
      }
    } finally {
      root.unmount()
    }
  }, 120_000)
})
