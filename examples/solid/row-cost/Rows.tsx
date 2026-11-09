// The message rows of ghia-bench's apps/ghia/src/App.tsx (Row, Avatar, oneLine, rowStyle, selectedRowStyle), verbatim, in a
// plain column (or one virtual-list), so every row is built on every frame. Window height is rows * 72 so none is clipped.
import { For } from 'solid-js'
import type { StyleDesc } from '@ghia/solid'
import type { Message } from '../mailbox-scroll-hover/types'
import { Show } from 'solid-js'

const ROW_HEIGHT = 72

const AVATAR_COLORS = ['#F87171', '#FB923C', '#FBBF24', '#34D399', '#22D3EE', '#60A5FA', '#A78BFA', '#F472B6']

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
      <text style={{ fontSize: props.fontSize, fontWeight: 600, color: '#FFFFFF' }}>{initials(props.name)}</text>
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
          <text
            style={{
              ...oneLine,
              minWidth: 0,
              fontSize: 13,
              fontWeight: props.message.unread ? 600 : 500,
              color: props.message.unread ? '#18181B' : '#3F3F46',
            }}
          >
            {props.message.fromName}
          </text>
          <text style={{ flexShrink: 0, fontSize: 12, color: '#71717A' }}>{props.message.time}</text>
        </div>
        <text style={{ ...oneLine, height: 18, lineHeight: '18px', fontSize: 13, color: '#27272A' }}>
          {props.message.subject}
        </text>
        <text style={{ ...oneLine, height: 16, lineHeight: '16px', fontSize: 12, color: '#71717A' }}>
          {props.message.snippet}
        </text>
      </div>
    </div>
  )
}

/** `container: "column"` is a plain flex column; `"list"` is the `<virtual-list>` the bench's list is (the same row patches apply). */
export function Rows(props: { messages: Message[]; selected: number; container: 'column' | 'list' }) {
  const rows = () => (
    <For each={props.messages}>
      {(message, index) => <Row message={message} selected={index() === props.selected} onSelect={() => {}} />}
    </For>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: '#FFFFFF' }}>
      {props.container === 'list' ? (
        <virtual-list
          itemCount={props.messages.length}
          estimatedItemHeight={ROW_HEIGHT}
          windowStart={0}
          style={{ flexGrow: 1, minHeight: 0 }}
        >
          {rows()}
        </virtual-list>
      ) : (
        rows()
      )}
    </div>
  )
}
