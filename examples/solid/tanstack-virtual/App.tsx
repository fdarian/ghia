// The list column of ghia-bench's Electron app (apps/electron/src/renderer/App.tsx), running @tanstack/solid-virtual
// unchanged. The virtualizer, `<For each={virtualizer.getVirtualItems()}>`, the absolute rows with `translateY` and
// `scrollToOffset`/`scrollToIndex` are the bench's. Changes, all of them:
//  1. Ghia has no stylesheets, so `class`, `classList` and styles.css are inline `style` objects with the same values
//     (`:hover` is the `hover` key, `:focus` the `focusVisible` key). `avatarClass` is `avatarStyle`, which returns the
//     background of `.avatar-N` instead of a class name.
//  2. The sidebar and the detail pane are left out: they do not touch the virtualizer. `detailEl` and its two
//     `scrollTop = 0` lines go with the detail pane.
//  3. The messages come in as a prop instead of `fetch('./messages.json')`, and `inputEl.focus()` is `autoFocus`.
//  4. Ghia has no `onInput`: its `onChange` is the DOM's `input` event, and the text is `event.value`, not
//     `event.currentTarget.value` (docs/reference.md, "The change event"). `inputEl.value = ''` is kept; an input
//     element has no `value` member on Ghia, so on Escape it clears nothing.
//  5. `listEl` is typed as the host element of Ghia, whose type is not an `HTMLDivElement`, hence the `as never`.
//  6. `<section>` is a `<div>`: Ghia has no `section` element.
//  7. The list and its inner div have a `testId`, which the test finds them by.
import { createMemo, createSignal, For, Show } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import type { HostElement, StyleDesc } from '@ghia/solid'
import type { Message } from './types'

const ROW_HEIGHT = 72

const numberFormat = new Intl.NumberFormat('en-US')

const AVATAR_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#34d399', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6']

function avatarStyle(name: string): StyleDesc {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash += name.charCodeAt(i)
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    borderRadius: '50%',
    color: '#ffffff',
    fontWeight: 600,
    background: AVATAR_COLORS[hash % 8],
  }
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
}

const oneLine: StyleDesc = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function rowStyle(selected: boolean, top: number): StyleDesc {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: 72,
    borderBottom: '1px solid #f4f4f5',
    userSelect: 'none',
    background: selected ? '#dbeafe' : undefined,
    hover: { background: selected ? '#dbeafe' : '#f4f4f5' },
    transform: `translateY(${top}px)`,
  }
}

function Row(props: { message: Message; selected: boolean; top: number; onSelect: () => void }) {
  return (
    <div style={rowStyle(props.selected, props.top)} onClick={props.onSelect}>
      <Show when={props.message.unread}>
        <span
          style={{ position: 'absolute', left: 4, top: 17, width: 8, height: 8, borderRadius: '50%', background: '#2563eb' }}
        />
      </Show>
      <div
        style={{
          ...avatarStyle(props.message.fromName),
          position: 'absolute',
          left: 16,
          top: 12,
          width: 36,
          height: 36,
          fontSize: 13,
        }}
      >
        {initials(props.message.fromName)}
      </div>
      <div style={{ position: 'absolute', left: 64, right: 16, top: 12 }}>
        <div style={{ height: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span
            style={{
              minWidth: 0,
              ...oneLine,
              fontSize: 13,
              fontWeight: props.message.unread ? 600 : 500,
              color: props.message.unread ? '#18181b' : '#3f3f46',
            }}
          >
            {props.message.fromName}
          </span>
          <span style={{ flex: 'none', fontSize: 12, color: '#71717a' }}>{props.message.time}</span>
        </div>
        <div style={{ ...oneLine, height: 18, lineHeight: '18px', fontSize: 13, color: '#27272a' }}>
          {props.message.subject}
        </div>
        <div style={{ ...oneLine, height: 16, lineHeight: '16px', fontSize: 12, color: '#71717a' }}>
          {props.message.snippet}
        </div>
      </div>
    </div>
  )
}

export function App(props: { messages: Message[] }) {
  const [messages] = createSignal<Message[]>(props.messages)
  const [haystacks] = createSignal<string[]>(
    props.messages.map((m) => `${m.fromName} ${m.subject} ${m.snippet}`.toLowerCase()),
  )
  const [query, setQuery] = createSignal('')
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  let listEl!: HostElement
  let inputEl!: HostElement & { value: string }

  const results = createMemo(() => {
    const q = query()
    const all = messages()
    if (q === '') return all
    const hay = haystacks()
    return all.filter((_, i) => hay[i].includes(q))
  })

  const virtualizer = createVirtualizer({
    get count() {
      return results().length
    },
    getScrollElement: () => listEl as never,
    estimateSize: () => ROW_HEIGHT,
  })

  function select(index: number) {
    setSelectedIndex(index)
  }

  function setFilter(value: string) {
    setQuery(value.trim().toLowerCase())
    setSelectedIndex(0)
    virtualizer.scrollToOffset(0)
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = results().length
      if (count === 0) return
      const next = Math.min(count - 1, Math.max(0, selectedIndex() + (event.key === 'ArrowDown' ? 1 : -1)))
      select(next)
      virtualizer.scrollToIndex(next, { align: 'auto' })
    } else if (event.key === 'Escape') {
      inputEl.value = ''
      setFilter('')
    }
  }

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div
        style={{
          flex: 'none',
          width: 420,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff',
          borderRight: '1px solid #e4e4e7',
        }}
      >
        <div style={{ flex: 'none', height: 56, padding: 12 }}>
          <input
            ref={inputEl}
            autoFocus
            type="text"
            placeholder="Search mail"
            spellcheck={false}
            onChange={(event) => setFilter(event.value ?? '')}
            onKeyDown={onKeyDown}
            style={{
              display: 'block',
              width: 396,
              height: 32,
              padding: '0 10px',
              border: '1px solid #e4e4e7',
              borderRadius: 8,
              background: '#f4f4f5',
              outline: 'none',
              font: 'inherit',
              fontSize: 13,
              color: '#18181b',
              focusVisible: { borderColor: '#2563eb' },
            }}
          />
        </div>
        <div style={{ flex: 'none', height: 28, paddingLeft: 16, lineHeight: '28px', fontSize: 12, color: '#71717a' }}>
          {numberFormat.format(results().length)} conversations
        </div>
        <div testId="list" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} ref={listEl}>
          <div testId="list-inner" style={{ position: 'relative', width: '100%', height: `${virtualizer.getTotalSize()}px` }}>
            <For each={virtualizer.getVirtualItems()}>
              {(item) => (
                <Show when={results()[item.index]}>
                  {(message) => (
                    <Row
                      message={message()}
                      selected={item.index === selectedIndex()}
                      top={item.start}
                      onSelect={() => select(item.index)}
                    />
                  )}
                </Show>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}
