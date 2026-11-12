import { describe, it } from 'vitest'
import { appendFileSync } from 'node:fs'
import { Popover } from '@base-ui/react/popover'
import { box, byText, click, mount, press, query, queryAll, settle } from './harness'
const log = (s: string) => appendFileSync('/tmp/probe.log', s + '\n')
const desc = (e: Element | null) => e === null ? 'null' : `${e.localName}[${e.getAttribute('role') ?? ''}${e.getAttribute('data-testid') ?? ''}] "${(e.textContent ?? '').slice(0, 12)}"`
describe('probe', () => {
  it('popover focus', async () => {
    const app = mount(
      <div style={{ position: 'absolute', top: 100, left: 150, width: 300, height: 300 }}>
        <Popover.Root>
          <Popover.Trigger style={{ display: 'block', width: 100, height: 30 }}>Open</Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="start" sideOffset={8}>
              <Popover.Popup data-testid="popup" style={{ display: 'block', width: 180, height: 90 }}>
                <Popover.Title style={{ margin: 0 }}>Notes</Popover.Title>
                <input aria-label="Note" style={{ display: 'block', width: 120, height: 24 }} />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <button type="button" style={{ display: 'block', width: 100, height: 30, marginTop: 200 }}>Elsewhere</button>
      </div>,
    )
    log('elsewhere before: ' + JSON.stringify(byText('Elsewhere', 'button').getBoundingClientRect()))
    await click(app, byText('Open', 'button'))
    log('after open: active=' + desc(document.activeElement))
    log('elsewhere after open: ' + JSON.stringify(byText('Elsewhere', 'button').getBoundingClientRect()))
    await press(app, 'Escape')
    log('after escape: active=' + desc(document.activeElement) + ' popup=' + queryAll('[data-testid=popup]').length)
    await settle(app, 100)
    log('after escape+100: active=' + desc(document.activeElement))
  })
})
