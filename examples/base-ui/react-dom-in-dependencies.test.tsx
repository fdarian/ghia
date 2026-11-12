import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { useLayoutEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import * as ghiaReactDom from '@ghia/react/react-dom'
import { hasNativeTestRenderer } from '@ghia/react/testing'
import { mount, settle } from './harness'

// Wraps `flushSync` and nothing else. A mock is keyed by the module a specifier resolves to, so a call reaches the
// spy only from an importer whose `react-dom` is `@ghia/react`'s: the real react-dom, which Node resolves for a
// dependency that is not inlined, would bypass it.
const flushed = vi.hoisted(() => ({ calls: 0 }))
vi.mock('react-dom', async () => {
  const original = await vi.importActual<typeof import('@ghia/react/react-dom')>('@ghia/react/react-dom')
  return {
    ...original,
    flushSync: (callback: () => void) => {
      flushed.calls += 1
      return original.flushSync(callback)
    },
  }
})

const describeNative = hasNativeTestRenderer ? describe : describe.skip

// `@floating-ui/react-dom` is Base UI's dependency, not this package's: it is found from where Base UI is installed.
// Its own `import * as ReactDOM from 'react-dom'` is the import under test.
const baseUi = createRequire(import.meta.url).resolve('@base-ui/react/package.json')
const floatingUi = join(dirname(createRequire(baseUi).resolve('@floating-ui/react-dom/package.json')), 'dist/floating-ui.react-dom.mjs')

describeNative('react-dom inside a dependency', () => {
  it('is the @ghia/react module for @floating-ui/react-dom, which positions with flushSync', async () => {
    const floating: typeof import('@floating-ui/react-dom') = await import(/* @vite-ignore */ floatingUi)
    function Positioned() {
      const position = floating.useFloating({ open: true, placement: 'bottom-start' })
      useLayoutEffect(() => {
        position.refs.setReference(document.body)
      }, [])
      return (
        <div ref={position.refs.setFloating} style={{ position: 'absolute', width: 40, height: 20, ...position.floatingStyles }} />
      )
    }
    const app = mount(<Positioned />)
    await settle(app)
    expect(flushed.calls).toBeGreaterThan(0)
  })

  // `importActual` skips the mock above, so the file `react-dom` resolves to is compared with `@ghia/react`'s: the
  // same module only while the plugin aliases it, where a mocked `react-dom` and `@ghia/react/react-dom` always match.
  it('is what a test file gets too', async () => {
    const resolved = await vi.importActual<typeof import('react-dom')>('react-dom')
    expect(resolved.createPortal).toBe(ghiaReactDom.createPortal)
    expect(resolved.version).toBe(ghiaReactDom.version)
  })
})
