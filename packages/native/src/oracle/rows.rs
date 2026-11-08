//! The view of the oracle: `render_row` and `avatar` of ghia-bench's `apps/gpui/src/main.rs`,
//! copied so the divs, styles and texts are the bench's.

use std::cell::Cell;

use gpui::{div, prelude::*, px, rgb, Context, FontWeight, Rgba, SharedString, Window};

const MUTED: u32 = 0x71717A;
const AVATAR_COLORS: [u32; 8] = [0xF87171, 0xFB923C, 0xFBBF24, 0x34D399, 0x22D3EE, 0x60A5FA, 0xA78BFA, 0xF472B6];

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRow {
    from_name: String,
    subject: String,
    snippet: String,
    time: String,
    unread: bool,
}

pub struct Row {
    from_name: SharedString,
    subject: SharedString,
    snippet: SharedString,
    time: SharedString,
    unread: bool,
    initials: SharedString,
    avatar: Rgba,
}

impl From<RawRow> for Row {
    fn from(raw: RawRow) -> Self {
        // data.rs of the bench.
        let initials: String =
            raw.from_name.split_whitespace().take(2).filter_map(|word| word.chars().next()).collect();
        let hash: u32 = raw.from_name.encode_utf16().map(u32::from).sum();
        Row {
            from_name: raw.from_name.into(),
            subject: raw.subject.into(),
            snippet: raw.snippet.into(),
            time: raw.time.into(),
            unread: raw.unread,
            initials: initials.into(),
            avatar: rgb(AVATAR_COLORS[(hash % 8) as usize]),
        }
    }
}

pub fn parse(json: &str) -> Result<Vec<Row>, String> {
    let raw: Vec<RawRow> = serde_json::from_str(json).map_err(|error| error.to_string())?;
    Ok(raw.into_iter().map(Row::from).collect())
}

pub struct RawRows {
    rows: Vec<Row>,
    selected: Option<usize>,
    pub renders: u64,
    pub divs: Cell<u64>,
    pub texts: Cell<u64>,
    clicks: u64,
}

impl RawRows {
    pub fn new() -> Self {
        RawRows { rows: Vec::new(), selected: None, renders: 0, divs: Cell::new(0), texts: Cell::new(0), clicks: 0 }
    }

    pub fn set_rows(&mut self, rows: Vec<Row>, selected: Option<usize>) {
        self.rows = rows;
        self.selected = selected;
    }

    fn render_row(&self, position: usize, cx: &mut Context<Self>) -> impl IntoElement {
        let row = &self.rows[position];
        let selected = self.selected == Some(position);
        // 9 divs (10 unread) and 5 text leaves.
        self.divs.set(self.divs.get() + 9 + u64::from(row.unread));
        self.texts.set(self.texts.get() + 5);
        let message = row;
        div()
            .id(position)
            .relative()
            .flex_none()
            .w_full()
            .h(px(72.))
            .bg(if selected { rgb(0xDBEAFE) } else { rgb(0xFFFFFF) })
            .when(!selected, |row| row.hover(|style| style.bg(rgb(0xF4F4F5))))
            .on_click(cx.listener(move |this, _, _, _cx| this.clicks += 1))
            .when(message.unread, |row| {
                row.child(
                    div()
                        .absolute()
                        .left(px(4.))
                        .top(px(17.))
                        .size(px(8.))
                        .rounded_full()
                        .bg(rgb(0x2563EB)),
                )
            })
            .child(avatar(36., 13., message.avatar, message.initials.clone()).absolute().left(px(16.)).top(px(12.)))
            .child(
                div()
                    .absolute()
                    .left(px(64.))
                    .right(px(16.))
                    .top(px(12.))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .h(px(18.))
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .child(
                                div()
                                    .truncate()
                                    .min_w_0()
                                    .when(message.unread, |name| {
                                        name.font_weight(FontWeight::SEMIBOLD).text_color(rgb(0x18181B))
                                    })
                                    .when(!message.unread, |name| {
                                        name.font_weight(FontWeight::MEDIUM).text_color(rgb(0x3F3F46))
                                    })
                                    .child(message.from_name.clone()),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .pl(px(8.))
                                    .text_size(px(12.))
                                    .text_color(rgb(MUTED))
                                    .child(message.time.clone()),
                            ),
                    )
                    .child(
                        div()
                            .truncate()
                            .h(px(18.))
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(rgb(0x27272A))
                            .child(message.subject.clone()),
                    )
                    .child(
                        div()
                            .truncate()
                            .h(px(16.))
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(rgb(MUTED))
                            .child(message.snippet.clone()),
                    ),
            )
            .child(div().absolute().bottom_0().left_0().right_0().h(px(1.)).bg(rgb(0xF4F4F5)))
    }
}

impl Render for RawRows {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let rows: Vec<_> = (0..self.rows.len()).map(|position| self.render_row(position, cx)).collect();
        div().flex().flex_col().size_full().bg(rgb(0xFFFFFF)).children(rows)
    }
}

fn avatar(diameter: f32, font_size: f32, color: Rgba, initials: SharedString) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .justify_center()
        .flex_none()
        .size(px(diameter))
        .rounded_full()
        .bg(color)
        .text_size(px(font_size))
        .line_height(px(font_size + 3.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(0xFFFFFF))
        .child(initials)
}
