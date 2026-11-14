import { describe, expect, it } from 'vitest'
import { ScrollArea } from '@photon-ai/base-ui-solid/scroll-area'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { box, center, mount, query, settle } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function Example() {
  return (
    <ScrollArea.Root
      data-testid="root"
      style={{ display: 'block', width: '200px', height: '100px', position: 'relative' }}
    >
      <ScrollArea.Viewport data-testid="viewport" style={{ display: 'block', width: '200px', height: '100px' }}>
        <ScrollArea.Content>
          <div style={{ width: '180px', height: '600px' }}>tall content</div>
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar
        orientation="vertical"
        data-testid="scrollbar"
        style={{ position: 'absolute', top: '0px', right: '0px', width: '10px', height: '100px' }}
      >
        <ScrollArea.Thumb data-testid="thumb" style={{ display: 'block', width: '10px' }} />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  )
}

describeNative('Base UI Solid ScrollArea', () => {
  it('lays out a viewport that scrolls its taller content, and a thumb sized to the visible share', async () => {
    const app = mount(() => <Example />)
    await settle(app)
    const viewport = query('[data-testid="viewport"]')
    expect(viewport.scrollHeight).toBeGreaterThanOrEqual(600)
    expect(viewport.clientHeight).toBe(100)
    expect(viewport.scrollTop).toBe(0)
    const thumb = box(query('[data-testid="thumb"]'))
    expect(thumb.height).toBeGreaterThan(5)
    expect(thumb.height).toBeLessThan(40)
  })

  it('scrolls the viewport on a wheel and moves the thumb with it', async () => {
    const app = mount(() => <Example />)
    await settle(app)
    const viewport = query('[data-testid="viewport"]')
    const thumbBefore = box(query('[data-testid="thumb"]'))
    const point = center(viewport)
    app.renderer.nativeSimulateScrollWheel(point.x, point.y, 0, 120)
    await settle(app)
    expect(viewport.scrollTop).toBeGreaterThan(0)
    const thumbAfter = box(query('[data-testid="thumb"]'))
    expect(thumbAfter.y).toBeGreaterThan(thumbBefore.y)
  })

  // The Solid ports' Root has no state (no `data-scrolling` or `data-has-overflow-*`); the Scrollbar carries `data-scrolling`.
  it('shows the scrolling state on the scrollbar while it scrolls', async () => {
    const app = mount(() => <Example />)
    await settle(app)
    expect(query('[data-testid="scrollbar"]').hasAttribute('data-scrolling')).toBe(false)
    const point = center(query('[data-testid="viewport"]'))
    app.renderer.nativeSimulateScrollWheel(point.x, point.y, 0, 60)
    await settle(app)
    const scrollbar = query('[data-testid="scrollbar"]')
    expect(scrollbar.hasAttribute('data-scrolling')).toBe(true)
    expect(scrollbar.getAttribute('data-orientation')).toBe('vertical')
  })
})
