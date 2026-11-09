// A mostly static settings dialog of about 200 elements: sections of label rows with a few dynamic text holes (signals) and a few onClick
// handlers. It stands for what an app mounts once: startup, a route change, a dialog. Rows are components, as an app writes them.
import type { Accessor, JSX } from "solid-js"

export interface SettingsValues {
  name: Accessor<string>
  email: Accessor<string>
  plan: Accessor<string>
  theme: Accessor<string>
  storage: Accessor<string>
  version: Accessor<string>
}

function Toggle(props: { on: boolean; onClick?: () => void }) {
  return (
    <div
      onClick={props.onClick}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        width: 36,
        height: 20,
        padding: 2,
        borderRadius: 10,
        backgroundColor: props.on ? "#2563EB" : "#D4D4D8",
        justifyContent: props.on ? "flex-end" : "flex-start",
      }}
    >
      <div style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: "#FFFFFF" }} />
    </div>
  )
}

function Row(props: { label: string; hint: string; children: JSX.Element }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        minHeight: 48,
        paddingTop: 8,
        paddingBottom: 8,
        borderBottom: "1px solid #F4F4F5",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flexGrow: 1 }}>
        <text style={{ fontSize: 14, fontWeight: 500, color: "#18181B" }}>{props.label}</text>
        <text style={{ fontSize: 12, color: "#71717A" }}>{props.hint}</text>
      </div>
      <div style={{ display: "flex", flexDirection: "row", alignItems: "center", flexShrink: 0 }}>{props.children}</div>
    </div>
  )
}

function Value(props: { text: string }) {
  return <text style={{ fontSize: 13, color: "#3F3F46" }}>{props.text}</text>
}

function ActionButton(props: { label: string; onClick: () => void }) {
  return (
    <div
      onClick={props.onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 28,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 6,
        backgroundColor: "#F4F4F5",
        border: "1px solid #E4E4E7",
      }}
    >
      <text style={{ fontSize: 13, color: "#18181B" }}>{props.label}</text>
    </div>
  )
}

function Section(props: { title: string; description: string; children: JSX.Element }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginBottom: 28 }}>
      <text style={{ fontSize: 16, fontWeight: 600, color: "#18181B" }}>{props.title}</text>
      <text style={{ fontSize: 12, color: "#71717A", marginBottom: 8 }}>{props.description}</text>
      {props.children}
    </div>
  )
}

export function SettingsDialog(props: { values: SettingsValues; onClose: () => void; onSave: () => void; onToggle: () => void }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.4)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 640,
          height: 720,
          borderRadius: 12,
          backgroundColor: "#FFFFFF",
          border: "1px solid #E4E4E7",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
            height: 56,
            paddingLeft: 24,
            paddingRight: 16,
            borderBottom: "1px solid #E4E4E7",
          }}
        >
          <text style={{ fontSize: 18, fontWeight: 600, color: "#18181B" }}>Settings</text>
          <ActionButton label="Close" onClick={props.onClose} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, padding: 24, overflowY: "auto" }}>
          <Section title="Account" description="Your profile and how you sign in.">
            <Row label="Name" hint="Shown on messages you send."><Value text={props.values.name()} /></Row>
            <Row label="Email" hint="Used for sign in and receipts."><Value text={props.values.email()} /></Row>
            <Row label="Password" hint="Last changed 3 months ago."><ActionButton label="Change" onClick={props.onSave} /></Row>
            <Row label="Two-factor authentication" hint="Ask for a code at sign in."><Toggle on={true} onClick={props.onToggle} /></Row>
            <Row label="Connected devices" hint="Devices signed in to this account."><Value text="3 devices" /></Row>
          </Section>
          <Section title="Appearance" description="How the app looks on this device.">
            <Row label="Theme" hint="Light, dark or follow the system."><Value text={props.values.theme()} /></Row>
            <Row label="Compact rows" hint="Fit more conversations on screen."><Toggle on={false} /></Row>
            <Row label="Show avatars" hint="Colored initials next to each sender."><Toggle on={true} /></Row>
            <Row label="Font size" hint="Applies to the list and the reading pane."><Value text="Medium" /></Row>
          </Section>
          <Section title="Notifications" description="When and how you are told about new mail.">
            <Row label="Desktop notifications" hint="Show a banner for new messages."><Toggle on={true} /></Row>
            <Row label="Sound" hint="Play a sound with each banner."><Toggle on={false} /></Row>
            <Row label="Badge count" hint="Unread count on the dock icon."><Toggle on={true} /></Row>
            <Row label="Quiet hours" hint="Mute banners overnight."><Value text="22:00 to 07:00" /></Row>
            <Row label="VIP senders" hint="Always notify for these people."><ActionButton label="Edit" onClick={props.onSave} /></Row>
          </Section>
          <Section title="Mail" description="Reading, composing and sending.">
            <Row label="Signature" hint="Added to the end of new messages."><ActionButton label="Edit" onClick={props.onSave} /></Row>
            <Row label="Undo send" hint="Hold a message for a few seconds."><Value text="10 seconds" /></Row>
            <Row label="Default reply" hint="Reply or reply all."><Value text="Reply" /></Row>
            <Row label="Load remote images" hint="Fetch images in messages."><Toggle on={false} /></Row>
          </Section>
          <Section title="Storage" description="What this account keeps on this device.">
            <Row label="Used" hint="Mail and attachments."><Value text={props.values.storage()} /></Row>
            <Row label="Offline mail" hint="Keep recent messages available offline."><Toggle on={true} /></Row>
            <Row label="Attachments" hint="Download attachments automatically."><Toggle on={false} /></Row>
            <Row label="Clear cache" hint="Free space; mail is fetched again."><ActionButton label="Clear" onClick={props.onSave} /></Row>
            <Row label="Export" hint="Save your mail as an archive."><ActionButton label="Export" onClick={props.onSave} /></Row>
          </Section>
          <Section title="About" description="This build.">
            <Row label="Plan" hint="Your current subscription."><Value text={props.values.plan()} /></Row>
            <Row label="Version" hint="Check for updates in the menu."><Value text={props.values.version()} /></Row>
            <Row label="Licenses" hint="Open source software in this app."><ActionButton label="View" onClick={props.onSave} /></Row>
            <Row label="Privacy" hint="What we collect and why."><ActionButton label="Read" onClick={props.onSave} /></Row>
          </Section>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            flexShrink: 0,
            height: 56,
            paddingRight: 24,
            borderTop: "1px solid #E4E4E7",
          }}
        >
          <ActionButton label="Cancel" onClick={props.onClose} />
          <ActionButton label="Save" onClick={props.onSave} />
        </div>
      </div>
    </div>
  )
}
