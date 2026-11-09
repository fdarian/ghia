// The bench's Detail pane (ghia-bench apps/ghia/src/App.tsx: Detail, Avatar, avatarColor, initials), verbatim apart from the imports.
import { For, Show } from "solid-js"
import type { HostElement, StyleDesc } from "@ghia/solid"
import type { Message } from "../mailbox-scroll-hover/types"

const AVATAR_COLORS = ["#F87171", "#FB923C", "#FBBF24", "#34D399", "#22D3EE", "#60A5FA", "#A78BFA", "#F472B6"]

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
    .join("")
}

function Avatar(props: { name: string; size: number; fontSize: number; style?: StyleDesc }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: props.size,
        height: props.size,
        borderRadius: props.size / 2,
        backgroundColor: avatarColor(props.name),
        ...props.style,
      }}
    >
      <text style={{ fontSize: props.fontSize, fontWeight: 600, color: "#FFFFFF" }}>{initials(props.name)}</text>
    </div>
  )
}

export function Detail(props: { message: Message | undefined; ref: (element: HostElement) => void }) {
  return (
    <div
      ref={props.ref}
      style={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        minWidth: 0,
        height: "100%",
        padding: 32,
        overflowY: "auto",
        backgroundColor: "#FFFFFF",
      }}
    >
      <Show
        when={props.message}
        keyed
        fallback={
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexGrow: 1 }}>
            <text style={{ fontSize: 14, color: "#A1A1AA" }}>No message selected</text>
          </div>
        }
      >
        {(message) => (
          <div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
            <text style={{ fontSize: 22, lineHeight: "28px", fontWeight: 600, color: "#18181B" }}>{message.subject}</text>
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 12,
                height: 40,
                marginTop: 16,
              }}
            >
              <Avatar name={message.fromName} size={40} fontSize={15} />
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <text style={{ height: 20, lineHeight: "20px", fontSize: 14, fontWeight: 600, color: "#18181B" }}>
                  {message.fromName}
                </text>
                <text style={{ height: 20, lineHeight: "20px", fontSize: 13, color: "#71717A" }}>{message.fromEmail}</text>
              </div>
              <text style={{ marginLeft: "auto", flexShrink: 0, fontSize: 12, color: "#71717A" }}>{message.dateLong}</text>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 24 }}>
              <For each={message.body}>
                {(paragraph) => <text style={{ fontSize: 14, lineHeight: "22px", color: "#27272A" }}>{paragraph}</text>}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
