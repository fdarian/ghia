//! The view of the oracle: `render_row` and `avatar` of ghia-bench's `apps/gpui/src/main.rs`,
//! copied so the divs, styles and texts are the bench's.

use std::{cell::Cell, rc::Rc};

use gpui::{div, prelude::*, px, rgb, AnyElement, Context, Div, ElementId, FontWeight, Rgba, SharedString, Window};

use super::direct::{Child, DirectKnobs, DirectRow, Node, RowTemplate};
use crate::automation::track_host_bounds;

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

/// How a row is built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    /// The bench's divs.
    Div,
    /// One [`DirectRow`] element per row.
    Direct,
    /// The Settings dialog of `mount-cost` as divs, a text being a div holding the string.
    Settings,
    /// The same, a text being a div holding a div holding the string (the text instance of a Ghia host element).
    SettingsWrapped,
}

/// What Ghia puts on each of its host divs, one at a time, so that its price can be read off the
/// raw row (`RowKind::Div` only). `hitbox` needs `Window::set_dom_hit_testing`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Decorations {
    /// `always_hitbox()`.
    pub hitbox: bool,
    /// `track_host_bounds`: the layout box read in prepaint, `note_host_node` and `record_bounds` in paint.
    pub bounds: bool,
    /// An element id on each div (a `Stateful<Div>`), as every host div has.
    pub ids: bool,
    /// The root column is a stacking context, as the window root of a Ghia page is: the absolute
    /// children of every row are lifted into it and sorted (`Window::end_stacking_context`).
    pub stacking_root: bool,
}

pub struct RawRows {
    rows: Vec<Row>,
    selected: Option<usize>,
    pub kind: RowKind,
    pub decorations: Decorations,
    pub direct: DirectKnobs,
    templates: Vec<Rc<RowTemplate>>,
    pub renders: u64,
    pub divs: Cell<u64>,
    pub texts: Cell<u64>,
    clicks: u64,
}

impl RawRows {
    pub fn new() -> Self {
        RawRows {
            rows: Vec::new(),
            selected: None,
            kind: RowKind::Div,
            decorations: Decorations::default(),
            direct: DirectKnobs { hitboxes: true, bounds: false, style_each_frame: false },
            templates: Vec::new(),
            renders: 0,
            divs: Cell::new(0),
            texts: Cell::new(0),
            clicks: 0,
        }
    }

    pub fn set_rows(&mut self, rows: Vec<Row>, selected: Option<usize>) {
        self.templates = rows
            .iter()
            .enumerate()
            .map(|(position, row)| Rc::new(template(row, position, selected == Some(position))))
            .collect();
        self.rows = rows;
        self.selected = selected;
    }

    fn render_row(&self, position: usize, cx: &mut Context<Self>) -> AnyElement {
        let row = &self.rows[position];
        // 9 divs (10 unread) and 5 text leaves.
        self.divs.set(self.divs.get() + 9 + u64::from(row.unread));
        self.texts.set(self.texts.get() + 5);
        if self.kind == RowKind::Direct {
            let texts = [row.initials.clone(), row.from_name.clone(), row.time.clone(), row.subject.clone(), row.snippet.clone()];
            return DirectRow::new(self.templates[position].clone(), texts, self.direct).into_any_element();
        }
        let selected = self.selected == Some(position);
        let decorations = self.decorations;
        let id = |node: u64| ((position as u64) << 4) + node + 1;
        let message = row;
        let mut dot = None;
        if message.unread {
            dot = Some(decorated(dot_style(), decorations, id(1)));
        }
        let avatar = decorated(avatar_style(message.avatar).child(message.initials.clone()), decorations, id(2));
        let name = decorated(name_style(message.unread).child(message.from_name.clone()), decorations, id(6));
        let time = decorated(time_style().child(message.time.clone()), decorations, id(7));
        let header = decorated(header_style().child(name).child(time), decorations, id(5));
        let subject = decorated(subject_style().child(message.subject.clone()), decorations, id(8));
        let snippet = decorated(snippet_style().child(message.snippet.clone()), decorations, id(9));
        let info = decorated(info_style().child(header).child(subject).child(snippet), decorations, id(4));
        let border = decorated(border_style(), decorations, id(10));
        let root = root_style(selected)
            .id(position)
            .when(!selected, |row| row.hover(|style| style.bg(rgb(0xF4F4F5))))
            .on_click(cx.listener(move |this, _, _, _cx| this.clicks += 1));
        let root = hosted(root, decorations, id(0));
        root.children(dot).child(avatar).child(info).child(border).into_any_element()
    }
}

impl Render for RawRows {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.renders += 1;
        match self.kind {
            RowKind::Settings => return div().relative().size_full().bg(rgb(0xFFFFFF)).child(super::settings::dialog(super::settings::TextShape::Plain)).into_any_element(),
            RowKind::SettingsWrapped => return div().relative().size_full().bg(rgb(0xFFFFFF)).child(super::settings::dialog(super::settings::TextShape::Wrapped)).into_any_element(),
            RowKind::Div | RowKind::Direct => {}
        }
        let rows: Vec<_> = (0..self.rows.len()).map(|position| self.render_row(position, cx)).collect();
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0xFFFFFF))
            .when(self.decorations.stacking_root, |root| root.stacking_context())
            .children(rows)
            .into_any_element()
    }
}

// The style of each node, shared by the Div row and the template of the direct row, so that both
// say the same thing.

fn root_style(selected: bool) -> Div {
    div().relative().flex_none().w_full().h(px(72.)).bg(if selected { rgb(0xDBEAFE) } else { rgb(0xFFFFFF) })
}

fn dot_style() -> Div {
    div().absolute().left(px(4.)).top(px(17.)).size(px(8.)).rounded_full().bg(rgb(0x2563EB))
}

fn avatar_style(color: Rgba) -> Div {
    avatar(36., 13., color).absolute().left(px(16.)).top(px(12.))
}

fn info_style() -> Div {
    div().absolute().left(px(64.)).right(px(16.)).top(px(12.)).flex().flex_col()
}

fn header_style() -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .h(px(18.))
        .text_size(px(13.))
        .line_height(px(18.))
}

fn name_style(unread: bool) -> Div {
    div()
        .truncate()
        .min_w_0()
        .when(unread, |name| name.font_weight(FontWeight::SEMIBOLD).text_color(rgb(0x18181B)))
        .when(!unread, |name| name.font_weight(FontWeight::MEDIUM).text_color(rgb(0x3F3F46)))
}

fn time_style() -> Div {
    div().flex_none().pl(px(8.)).text_size(px(12.)).text_color(rgb(MUTED))
}

fn subject_style() -> Div {
    div().truncate().h(px(18.)).text_size(px(13.)).line_height(px(18.)).text_color(rgb(0x27272A))
}

fn snippet_style() -> Div {
    div().truncate().h(px(16.)).text_size(px(12.)).line_height(px(16.)).text_color(rgb(MUTED))
}

fn border_style() -> Div {
    div().absolute().bottom_0().left_0().right_0().h(px(1.)).bg(rgb(0xF4F4F5))
}

fn avatar(diameter: f32, font_size: f32, color: Rgba) -> Div {
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
}

/// What Ghia puts on a host element, see [`Decorations`].
fn hosted<E: InteractiveElement + Styled>(mut element: E, decorations: Decorations, id: u64) -> E {
    if decorations.hitbox {
        element = element.always_hitbox();
    }
    if decorations.bounds {
        element = track_host_bounds(element, id, None, false, false, None);
    }
    element
}

fn decorated(div: Div, decorations: Decorations, id: u64) -> AnyElement {
    if decorations.ids {
        hosted(div.id(ElementId::NamedInteger(SharedString::new_static("n"), id)), decorations, id).into_any_element()
    } else {
        hosted(div, decorations, id).into_any_element()
    }
}

/// The nodes of a row in tree order, with the texts as the leaves of the divs that hold them.
fn template(row: &Row, position: usize, selected: bool) -> RowTemplate {
    let mut nodes: Vec<Node> = Vec::new();
    let mut texts = 0;
    fn add(nodes: &mut Vec<Node>, parent: Option<usize>, mut div: Div) -> usize {
        let refinement = div.style().clone();
        let index = nodes.len();
        nodes.push(Node { style: RowTemplate::style_of(&refinement), refinement, children: Vec::new() });
        if let Some(parent) = parent {
            nodes[parent].children.push(Child::Node(index));
        }
        index
    }
    let mut text = |nodes: &mut Vec<Node>, parent: usize| {
        nodes[parent].children.push(Child::Text(texts));
        texts += 1;
    };
    let root = add(&mut nodes, None, root_style(selected));
    if row.unread {
        add(&mut nodes, Some(root), dot_style());
    }
    let avatar = add(&mut nodes, Some(root), avatar_style(row.avatar));
    text(&mut nodes, avatar);
    let info = add(&mut nodes, Some(root), info_style());
    let header = add(&mut nodes, Some(info), header_style());
    let name = add(&mut nodes, Some(header), name_style(row.unread));
    text(&mut nodes, name);
    let time = add(&mut nodes, Some(header), time_style());
    text(&mut nodes, time);
    let subject = add(&mut nodes, Some(info), subject_style());
    text(&mut nodes, subject);
    let snippet = add(&mut nodes, Some(info), snippet_style());
    text(&mut nodes, snippet);
    add(&mut nodes, Some(root), border_style());
    let hover_root = (!selected).then(|| RowTemplate::style_of(root_style(false).bg(rgb(0xF4F4F5)).style()));
    RowTemplate { nodes, hover_root, position }
}
