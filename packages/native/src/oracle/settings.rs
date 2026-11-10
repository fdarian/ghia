//! The Settings dialog of `examples/solid/mount-cost/Settings.tsx` as plain GPUI divs: the same
//! flex boxes, sizes, paddings, gaps and texts, and none of Ghia's host layer. It prices the layout
//! of the tree as any GPUI app that wrote it would get it.

use gpui::{div, prelude::*, px, rgb, rgba, AnyElement, Div, FontWeight, IntoElement, SharedString};

/// How a `<text>` is built: a div holding the string (what a GPUI app writes), or a div holding a
/// div holding the string (the text instance Ghia puts in a host element).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextShape {
    Plain,
    Wrapped,
}

struct Values {
    name: &'static str,
    email: &'static str,
    plan: &'static str,
    theme: &'static str,
    storage: &'static str,
    version: &'static str,
}

const VALUES: Values = Values {
    name: "Farrel Darian",
    email: "farrel@example.com",
    plan: "Pro",
    theme: "System",
    storage: "1.2 GB of 15 GB",
    version: "1.0.0",
};

fn text(shape: TextShape, style: Div, content: &str) -> AnyElement {
    let content = SharedString::from(content.to_string());
    match shape {
        TextShape::Plain => style.child(content).into_any_element(),
        TextShape::Wrapped => style.child(div().child(content)).into_any_element(),
    }
}

fn toggle(on: bool) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .w(px(36.))
        .h(px(20.))
        .p(px(2.))
        .rounded(px(10.))
        .bg(if on { rgb(0x2563EB) } else { rgb(0xD4D4D8) })
        .when(on, |toggle| toggle.justify_end())
        .when(!on, |toggle| toggle.justify_start())
        .child(div().w(px(16.)).h(px(16.)).rounded(px(8.)).bg(rgb(0xFFFFFF)))
        .into_any_element()
}

fn value(shape: TextShape, content: &str) -> AnyElement {
    text(shape, div().text_size(px(13.)).text_color(rgb(0x3F3F46)), content)
}

fn action_button(shape: TextShape, label: &str) -> AnyElement {
    div()
        .flex()
        .items_center()
        .justify_center()
        .h(px(28.))
        .px(px(12.))
        .rounded(px(6.))
        .bg(rgb(0xF4F4F5))
        .border_1()
        .border_color(rgb(0xE4E4E7))
        .child(text(shape, div().text_size(px(13.)).text_color(rgb(0x18181B)), label))
        .into_any_element()
}

fn row(shape: TextShape, label: &str, hint: &str, child: AnyElement) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .gap(px(16.))
        .min_h(px(48.))
        .pt(px(8.))
        .pb(px(8.))
        .border_b_1()
        .border_color(rgb(0xF4F4F5))
        .child(
            div()
                .flex()
                .flex_col()
                .min_w_0()
                .flex_grow(1.)
                .child(text(shape, div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).text_color(rgb(0x18181B)), label))
                .child(text(shape, div().text_size(px(12.)).text_color(rgb(0x71717A)), hint)),
        )
        .child(div().flex().flex_row().items_center().flex_shrink_0().child(child))
        .into_any_element()
}

fn section(shape: TextShape, title: &str, description: &str, rows: Vec<AnyElement>) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .mb(px(28.))
        .child(text(shape, div().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).text_color(rgb(0x18181B)), title))
        .child(text(shape, div().text_size(px(12.)).text_color(rgb(0x71717A)).mb(px(8.)), description))
        .children(rows)
        .into_any_element()
}

pub fn dialog(shape: TextShape) -> impl IntoElement {
    let sections = vec![
        section(shape, "Account", "Your profile and how you sign in.", vec![
            row(shape, "Name", "Shown on messages you send.", value(shape, VALUES.name)),
            row(shape, "Email", "Used for sign in and receipts.", value(shape, VALUES.email)),
            row(shape, "Password", "Last changed 3 months ago.", action_button(shape, "Change")),
            row(shape, "Two-factor authentication", "Ask for a code at sign in.", toggle(true)),
            row(shape, "Connected devices", "Devices signed in to this account.", value(shape, "3 devices")),
        ]),
        section(shape, "Appearance", "How the app looks on this device.", vec![
            row(shape, "Theme", "Light, dark or follow the system.", value(shape, VALUES.theme)),
            row(shape, "Compact rows", "Fit more conversations on screen.", toggle(false)),
            row(shape, "Show avatars", "Colored initials next to each sender.", toggle(true)),
            row(shape, "Font size", "Applies to the list and the reading pane.", value(shape, "Medium")),
        ]),
        section(shape, "Notifications", "When and how you are told about new mail.", vec![
            row(shape, "Desktop notifications", "Show a banner for new messages.", toggle(true)),
            row(shape, "Sound", "Play a sound with each banner.", toggle(false)),
            row(shape, "Badge count", "Unread count on the dock icon.", toggle(true)),
            row(shape, "Quiet hours", "Mute banners overnight.", value(shape, "22:00 to 07:00")),
            row(shape, "VIP senders", "Always notify for these people.", action_button(shape, "Edit")),
        ]),
        section(shape, "Mail", "Reading, composing and sending.", vec![
            row(shape, "Signature", "Added to the end of new messages.", action_button(shape, "Edit")),
            row(shape, "Undo send", "Hold a message for a few seconds.", value(shape, "10 seconds")),
            row(shape, "Default reply", "Reply or reply all.", value(shape, "Reply")),
            row(shape, "Load remote images", "Fetch images in messages.", toggle(false)),
        ]),
        section(shape, "Storage", "What this account keeps on this device.", vec![
            row(shape, "Used", "Mail and attachments.", value(shape, VALUES.storage)),
            row(shape, "Offline mail", "Keep recent messages available offline.", toggle(true)),
            row(shape, "Attachments", "Download attachments automatically.", toggle(false)),
            row(shape, "Clear cache", "Free space; mail is fetched again.", action_button(shape, "Clear")),
            row(shape, "Export", "Save your mail as an archive.", action_button(shape, "Export")),
        ]),
        section(shape, "About", "This build.", vec![
            row(shape, "Plan", "Your current subscription.", value(shape, VALUES.plan)),
            row(shape, "Version", "Check for updates in the menu.", value(shape, VALUES.version)),
            row(shape, "Licenses", "Open source software in this app.", action_button(shape, "View")),
            row(shape, "Privacy", "What we collect and why.", action_button(shape, "Read")),
        ]),
    ];
    div()
        .absolute()
        .left_0()
        .top_0()
        .right_0()
        .bottom_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(rgba(0x00000066))
        .child(
            div()
                .flex()
                .flex_col()
                .w(px(640.))
                .h(px(720.))
                .rounded(px(12.))
                .bg(rgb(0xFFFFFF))
                .border_1()
                .border_color(rgb(0xE4E4E7))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .flex_shrink_0()
                        .h(px(56.))
                        .pl(px(24.))
                        .pr(px(16.))
                        .border_b_1()
                        .border_color(rgb(0xE4E4E7))
                        .child(text(shape, div().text_size(px(18.)).font_weight(FontWeight::SEMIBOLD).text_color(rgb(0x18181B)), "Settings"))
                        .child(action_button(shape, "Close")),
                )
                .child(
                    div()
                        .id("settings-body")
                        .flex()
                        .flex_col()
                        .flex_grow(1.)
                        .min_h_0()
                        .p(px(24.))
                        .overflow_y_scroll()
                        .children(sections),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_end()
                        .gap(px(8.))
                        .flex_shrink_0()
                        .h(px(56.))
                        .pr(px(24.))
                        .border_t_1()
                        .border_color(rgb(0xE4E4E7))
                        .child(action_button(shape, "Cancel"))
                        .child(action_button(shape, "Save")),
                ),
        )
}
