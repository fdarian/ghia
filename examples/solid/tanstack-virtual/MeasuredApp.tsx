// The same list with rows of different heights, which the virtualizer measures: a `ref` that calls
// `virtualizer.measureElement` and `data-index` on each row. virtual-core reads `getAttribute('data-index')`, `isConnected`,
// `offsetHeight` and a `ResizeObserver` of the row (`borderBoxSize`) from them. The `ref` is Solid's usual wrapper for it:
// `ref` runs before the element's other attributes are set, so the measure waits a microtask for `data-index`.
// Styles are inline as in App.tsx.
import { For } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import type { HostElement } from '@ghia/solid'
import type { Message } from './types'

const ESTIMATED_ROW_HEIGHT = 72
const LINE_HEIGHT = 16
const ROW_PADDING = 12

/** A row has one to three snippet lines, by its id, so the rows measure to three different heights. */
export function measuredRowHeight(message: Message) {
  return ROW_PADDING * 2 + 18 + LINE_HEIGHT * ((message.id % 3) + 1)
}

export function MeasuredApp(props: { messages: Message[] }) {
    let listEl!: HostElement

  const virtualizer = createVirtualizer({
    get count() {
      return props.messages.length
    },
    getScrollElement: () => listEl as never,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
  })

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div testId="list" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} ref={listEl}>
        <div testId="list-inner" style={{ position: 'relative', width: '100%', height: `${virtualizer.getTotalSize()}px` }}>
          <For each={virtualizer.getVirtualItems()}>
            {(item) => (
              <div
                ref={(el) => queueMicrotask(() => virtualizer.measureElement(el))}
                data-index={item.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  padding: ROW_PADDING,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <div style={{ height: 18, fontSize: 13 }}>{props.messages[item.index].subject}</div>
                <For each={Array.from({ length: (props.messages[item.index].id % 3) + 1 })}>
                  {() => <div style={{ height: LINE_HEIGHT, fontSize: 12 }}>{props.messages[item.index].snippet}</div>}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
