import { For, Show, batch, createMemo, createSignal } from 'solid-js'
import type { HostElement, StyleDesc } from '@ghia/solid'
import type { Message } from './types'

// Profiling hook: profile.tsx puts a phase timer on globalThis; without it these calls just run `fn`.
const phaseRun: <T>(name: string, fn: () => T) => T =
  (globalThis as unknown as { __phase?: { run: <T>(name: string, fn: () => T) => T } }).__phase?.run ?? ((_name, fn) => fn())

const ROW_HEIGHT = 72
// Rows mounted around the first visible one. Native builds only the viewport plus its overdraw
// (about 24 rows); the rest of the window is slack so a fast scroll never reaches an unmounted row.
const WINDOW = 60
const WINDOW_STEP = 10
const WINDOW_LEAD = 15

const FOLDERS = ['Inbox', 'Starred', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash']
const FOLDER_COUNTS: Record<string, number> = {
  Starred: 24,
  Sent: 128,
  Drafts: 3,
  Archive: 2048,
  Spam: 12,
  Trash: 0,
}

const LABELS = [
  { name: 'Work', color: '#2563EB' },
  { name: 'Personal', color: '#16A34A' },
  { name: 'Finance', color: '#CA8A04' },
  { name: 'Travel', color: '#9333EA' },
  { name: 'Family', color: '#DB2777' },
  { name: 'Receipts', color: '#EA580C' },
  { name: 'Newsletters', color: '#0891B2' },
  { name: 'Projects', color: '#4F46E5' },
]

const AVATAR_COLORS = ['#F87171', '#FB923C', '#FBBF24', '#34D399', '#22D3EE', '#60A5FA', '#A78BFA', '#F472B6']

const numberFormat = new Intl.NumberFormat('en-US')
const formatCount = (count: number) => (count === 0 ? '' : numberFormat.format(count))

function avatarColor(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash += name.charCodeAt(i)
  return AVATAR_COLORS[hash % 8]
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
}

const oneLine: StyleDesc = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

function Avatar(props: { name: string; size: number; fontSize: number; style?: StyleDesc }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: props.size,
        height: props.size,
        borderRadius: props.size / 2,
        backgroundColor: avatarColor(props.name),
        ...props.style,
      }}
    >
      <div style={{ fontSize: props.fontSize, fontWeight: 600, color: '#FFFFFF' }}>{initials(props.name)}</div>
    </div>
  )
}

function Sidebar(props: { unreadCount: number }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        width: 220,
        height: '100%',
        backgroundColor: '#F4F4F5',
        borderRight: '1px solid #E4E4E7',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 0,
          height: 48,
          marginBottom: 8,
          paddingLeft: 16,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: '#18181B' }}>Mailbox</div>
      </div>
      <For each={FOLDERS}>
        {(name) => {
          const selected = name === 'Inbox'
          return (
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexShrink: 0,
                height: 32,
                marginLeft: 8,
                marginRight: 8,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 6,
                backgroundColor: selected ? '#E4E4E7' : undefined,
                hover: { backgroundColor: selected ? '#E4E4E7' : '#EBEBED' },
              }}
            >
              <div style={{ fontSize: 13, color: '#27272A' }}>{name}</div>
              <div style={{ fontSize: 12, color: '#71717A' }}>
                {formatCount(selected ? props.unreadCount : FOLDER_COUNTS[name])}
              </div>
            </div>
          )
        }}
      </For>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 0,
          height: 24,
          marginTop: 16,
          paddingLeft: 16,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: '#A1A1AA' }}>LABELS</div>
      </div>
      <For each={LABELS}>
        {(label) => (
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              flexShrink: 0,
              gap: 8,
              height: 28,
              marginLeft: 8,
              marginRight: 8,
              paddingLeft: 8,
              paddingRight: 8,
            }}
          >
            <div style={{ width: 8, height: 8, flexShrink: 0, borderRadius: 4, backgroundColor: label.color }} />
            <div style={{ fontSize: 13, color: '#3F3F46' }}>{label.name}</div>
          </div>
        )}
      </For>
    </div>
  )
}

const rowStyle: StyleDesc = {
  position: 'relative',
  height: ROW_HEIGHT,
  borderBottom: '1px solid #F4F4F5',
  userSelect: 'none',
  hover: { backgroundColor: '#F4F4F5' },
}
const selectedRowStyle: StyleDesc = {
  ...rowStyle,
  backgroundColor: '#DBEAFE',
  hover: { backgroundColor: '#DBEAFE' },
}

function Row(props: { message: Message; selected: boolean; onSelect: () => void }) {
  return (
    <div style={props.selected ? selectedRowStyle : rowStyle} onClick={props.onSelect}>
      <Show when={props.message.unread}>
        <div
          style={{ position: 'absolute', left: 4, top: 17, width: 8, height: 8, borderRadius: 4, backgroundColor: '#2563EB' }}
        />
      </Show>
      <Avatar
        name={props.message.fromName}
        size={36}
        fontSize={13}
        style={{ position: 'absolute', left: 16, top: 12 }}
      />
      <div style={{ position: 'absolute', left: 64, right: 16, top: 12, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            height: 18,
          }}
        >
          <div
            style={{
              ...oneLine,
              minWidth: 0,
              fontSize: 13,
              fontWeight: props.message.unread ? 600 : 500,
              color: props.message.unread ? '#18181B' : '#3F3F46',
            }}
          >
            {props.message.fromName}
          </div>
          <div style={{ flexShrink: 0, fontSize: 12, color: '#71717A' }}>{props.message.time}</div>
        </div>
        <div style={{ ...oneLine, height: 18, lineHeight: '18px', fontSize: 13, color: '#27272A' }}>
          {props.message.subject}
        </div>
        <div style={{ ...oneLine, height: 16, lineHeight: '16px', fontSize: 12, color: '#71717A' }}>
          {props.message.snippet}
        </div>
      </div>
    </div>
  )
}

function Detail(props: { message: Message | undefined; ref: (element: HostElement) => void }) {
  return (
    <div
      ref={props.ref}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minWidth: 0,
        height: '100%',
        padding: 32,
        overflowY: 'auto',
        backgroundColor: '#FFFFFF',
      }}
    >
      <Show
        when={props.message}
        keyed
        fallback={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexGrow: 1 }}>
            <div style={{ fontSize: 14, color: '#A1A1AA' }}>No message selected</div>
          </div>
        }
      >
        {(message) => (
          <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <div style={{ fontSize: 22, lineHeight: '28px', fontWeight: 600, color: '#18181B' }}>{message.subject}</div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 12,
                height: 40,
                marginTop: 16,
              }}
            >
              <Avatar name={message.fromName} size={40} fontSize={15} />
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ height: 20, lineHeight: '20px', fontSize: 14, fontWeight: 600, color: '#18181B' }}>
                  {message.fromName}
                </div>
                <div style={{ height: 20, lineHeight: '20px', fontSize: 13, color: '#71717A' }}>{message.fromEmail}</div>
              </div>
              <div style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 12, color: '#71717A' }}>{message.dateLong}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 24 }}>
              <For each={message.body}>
                {(paragraph) => <div style={{ fontSize: 14, lineHeight: '22px', color: '#27272A' }}>{paragraph}</div>}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

export function App(props: { messages: Message[] }) {
  const haystacks = props.messages.map((message) =>
    `${message.fromName} ${message.subject} ${message.snippet}`.toLowerCase(),
  )
  const unreadCount = props.messages.filter((message) => message.unread).length

  const [text, setText] = createSignal('')
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [windowStart, setWindowStart] = createSignal(0)

  let list!: HostElement
  let detail!: HostElement

  const results = createMemo(() => {
    const query = text().trim().toLowerCase()
    if (query === '') return props.messages
    return props.messages.filter((_, index) => haystacks[index].includes(query))
  })
  const selected = () => results()[selectedIndex()]
  const windowRows = () => results().slice(windowStart(), windowStart() + WINDOW)

  function select(index: number) {
    phaseRun('handler:setSelectedIndex', () => setSelectedIndex(index))
    phaseRun('handler:detail.scrollTo', () => detail.scrollTo({ top: 0 }))
  }

  function filter(value: string) {
    batch(() => {
      setText(value)
      setSelectedIndex(0)
      setWindowStart(0)
    })
    list.scrollTo({ top: 0 })
    detail.scrollTo({ top: 0 })
  }

  function reveal(index: number) {
    phaseRun('handler:reveal', () => {
      const top = index * ROW_HEIGHT
      const bottom = top + ROW_HEIGHT
      if (top < list.scrollTop) list.scrollTo({ top })
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTo({ top: bottom - list.clientHeight })
    })
  }

  function onKeyDown(event: { key?: string; preventDefault(): void }) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      phaseRun('handler:other', () => event.preventDefault())
      const count = results().length
      if (count === 0) return
      const next = Math.min(count - 1, Math.max(0, selectedIndex() + (event.key === 'ArrowDown' ? 1 : -1)))
      // Experiment: reveal() reads layout before select() writes.
      reveal(next)
      select(next)
    } else if (event.key === 'Escape') {
      filter('')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'row', width: '100%', height: '100%', backgroundColor: '#FFFFFF' }}>
      <Sidebar unreadCount={unreadCount} />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          width: 420,
          height: '100%',
          backgroundColor: '#FFFFFF',
          borderRight: '1px solid #E4E4E7',
        }}
      >
        <div style={{ flexShrink: 0, height: 56, padding: 12 }}>
          <input
            autoFocus
            value={text()}
            placeholder="Search mail"
            onChange={(event) => filter(event.value ?? '')}
            onKeyDown={onKeyDown}
            style={{
              width: 396,
              height: 32,
              paddingLeft: 10,
              paddingRight: 10,
              fontSize: 13,
              color: '#18181B',
              backgroundColor: '#F4F4F5',
              border: '1px solid #E4E4E7',
              borderRadius: 8,
              focusVisible: { borderColor: '#2563EB' },
            }}
          />
        </div>
        <div style={{ flexShrink: 0, height: 28, display: 'flex', alignItems: 'center', paddingLeft: 16 }}>
          <div style={{ fontSize: 12, color: '#71717A' }}>{`${numberFormat.format(results().length)} conversations`}</div>
        </div>
        <virtual-list
          ref={list}
          itemCount={results().length}
          estimatedItemHeight={ROW_HEIGHT}
          windowStart={windowStart()}
          onVisibleRange={(event) =>
            setWindowStart(
              Math.max(0, Math.floor(((event.startIndex ?? 0) - WINDOW_LEAD) / WINDOW_STEP) * WINDOW_STEP),
            )
          }
          style={{ flexGrow: 1, minHeight: 0 }}
        >
          <For each={windowRows()}>
            {(message, index) => (
              <Row
                message={message}
                selected={message === selected()}
                onSelect={() => select(windowStart() + index())}
              />
            )}
          </For>
        </virtual-list>
      </div>
      <Detail message={selected()} ref={(element) => (detail = element)} />
    </div>
  )
}
