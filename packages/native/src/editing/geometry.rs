//! The geometry reads editing needs, from the text the last painted frame holds.
//!
//! Every read starts from a DOM position or a window point, finds the paragraph that paints it
//! ([`super::positions`]) and asks that paragraph's `TextLayout`. Points in and out are window
//! coordinates, the ones `getBoundingClientRect` speaks; inside, a paragraph's own space.

use napi_derive::napi;
use gpui::{point, px, size, Bounds, Pixels, Point, TextLayout, TextRow, WindowId};

use crate::automation::{window_point_from, window_point_in};
use crate::retained_tree::RetainedTree;
use crate::text::inline_bounds;
use crate::text::inline::{is_raw_text, Child};
use crate::text::paint::{self, RegEntry};
use crate::text::plan_cache;

use super::positions::{self, Bias, DomPoint};

/// A rect in window coordinates.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
pub struct TextRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A DOM position, with where its caret is.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
pub struct CaretPoint {
    /// The `#text` node.
    pub node_id: f64,
    /// The element that holds the paragraph of the node, from which JS finds the node.
    pub container_id: f64,
    /// UTF-16 code units into the node's data.
    pub offset: f64,
    /// Window x of the caret. For a move up or down, the x the caret is kept at.
    pub x: f64,
}

/// A move of a caret by lines of the painted text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineMove {
    Up,
    Down,
    Start,
    End,
}

impl LineMove {
    pub fn parse(op: &str) -> Result<Self, String> {
        match op {
            "lineUp" => Ok(Self::Up),
            "lineDown" => Ok(Self::Down),
            "lineStart" => Ok(Self::Start),
            "lineEnd" => Ok(Self::End),
            other => Err(format!("moveCaretVisually does not know the move \"{other}\"")),
        }
    }
}

fn pixels(value: f64) -> Pixels {
    px(value as f32)
}

fn number(value: Pixels) -> f64 {
    f64::from(f32::from(value))
}

/// A point of the layout of `entry` in the window. The layout puts the text a fraction of a pixel
/// from where it paints it (`unsnapped_offset`); a box reads the first.
fn to_window(entry: &RegEntry, local: Point<Pixels>) -> Option<Point<Pixels>> {
    window_point_from(&entry.to_window, local + entry.layout.unsnapped_offset())
}

fn from_window(entry: &RegEntry, window: Point<Pixels>) -> Option<Point<Pixels>> {
    Some(window_point_in(&entry.to_window, window)? - entry.layout.unsnapped_offset())
}

/// The window box of the rect `local` of the layout of `entry`: the smallest that holds its corners.
pub(crate) fn window_rect(entry: &RegEntry, local: Bounds<Pixels>) -> Option<TextRect> {
    let corners = [local.origin, local.top_right(), local.bottom_left(), local.bottom_right()];
    let mut min = point(f64::MAX, f64::MAX);
    let mut max = point(f64::MIN, f64::MIN);
    for corner in corners {
        let at = to_window(entry, corner)?;
        min = point(min.x.min(number(at.x)), min.y.min(number(at.y)));
        max = point(max.x.max(number(at.x)), max.y.max(number(at.y)));
    }
    Some(TextRect { x: min.x, y: min.y, width: max.x - min.x, height: max.y - min.y })
}

/// Where the quads of a wash over `range` of the text of `entry` went, in window coordinates. The
/// wash is painted at the rects the layout gives, with no fraction of a pixel added.
pub(crate) fn wash_rects(entry: &RegEntry, range: &std::ops::Range<usize>) -> Vec<TextRect> {
    let mut local = paint::range_rects(&entry.layout, range, 0.0, 0.0);
    crate::text::inline_insets::trim_wash(&entry.layout, &entry.text, range, &mut local);
    local
        .into_iter()
        .filter_map(|rect| {
            let corners = [rect.origin, rect.top_right(), rect.bottom_left(), rect.bottom_right()];
            let mut min = point(f64::MAX, f64::MAX);
            let mut max = point(f64::MIN, f64::MIN);
            for corner in corners {
                let at = window_point_from(&entry.to_window, corner)?;
                min = point(min.x.min(number(at.x)), min.y.min(number(at.y)));
                max = point(max.x.max(number(at.x)), max.y.max(number(at.y)));
            }
            Some(TextRect { x: min.x, y: min.y, width: max.x - min.x, height: max.y - min.y })
        })
        .collect()
}

fn char_len_at(text: &str, byte: usize) -> usize {
    text[byte..].chars().next().map_or(0, char::len_utf8)
}

fn char_len_before(text: &str, byte: usize) -> usize {
    text[..byte].chars().next_back().map_or(0, char::len_utf8)
}

/// The size of the font the glyph at `byte` is set in, or of the glyph before it at the end of a
/// line, as the content area of the text there is measured at.
fn font_size_at(layout: &TextLayout, text: &str, byte: usize) -> Option<Pixels> {
    let glyph = if byte < text.len() && !text[byte..].starts_with('\n') {
        byte..byte + char_len_at(text, byte)
    } else {
        byte.checked_sub(char_len_before(text, byte))?..byte
    };
    let line_start = text[..glyph.start].rfind('\n').map_or(0, |at| at + 1);
    let line = layout.line_layout_for_index(glyph.start)?;
    let within = glyph.start - line_start..glyph.end - line_start;
    let size = line.runs_in(within).next().map(|run| run.font_size);
    size.or_else(|| Some(line.font_size()))
}

/// Where a caret at `byte` is in the layout: its x and the row it is on. A byte where a line wraps is
/// the start of the row below, which is where a caret that nothing says otherwise about is.
struct Caret {
    x: Pixels,
    row: TextRow,
}

fn caret_at(layout: &TextLayout, text: &str, byte: usize) -> Option<Caret> {
    let at = layout.position_for_index(byte)?;
    if byte < text.len() && !text[byte..].starts_with('\n') {
        let next = byte + char_len_at(text, byte);
        if let Some(after) = layout.position_for_index(next) {
            if after.y > at.y {
                let row = layout.row_for_index(next)?;
                return Some(Caret { x: layout.bounds().left() + layout.align_offset_at(next), row });
            }
        }
    }
    Some(Caret { x: at.x, row: layout.row_for_index(byte)? })
}

/// The rect the font of the text at `byte` takes at a caret there: no width, the ascent above the
/// baseline of the row and the descent below it.
fn caret_rect(layout: &TextLayout, text: &str, byte: usize) -> Option<Bounds<Pixels>> {
    let caret = caret_at(layout, text, byte)?;
    let font_size = font_size_at(layout, text, byte)?;
    let glyph = if byte < text.len() && !text[byte..].starts_with('\n') {
        byte..byte + char_len_at(text, byte)
    } else {
        byte - char_len_before(text, byte)..byte
    };
    let (ascent, descent) = layout.content_extent(glyph, font_size)?;
    Some(Bounds::new(point(caret.x, caret.row.baseline - ascent), size(Pixels::ZERO, ascent + descent)))
}

fn index_at(layout: &TextLayout, at: Point<Pixels>) -> usize {
    match layout.index_for_position(at) {
        Ok(index) | Err(index) => index,
    }
}

/// A visual row of a paragraph: the bytes of its text, and where it is.
#[derive(Debug, Clone, Copy)]
struct Row {
    start: usize,
    /// Where a caret ends the row: before the spaces that hang off the end of a row that wraps.
    end: usize,
    top: Pixels,
    height: Pixels,
}

impl Row {
    fn middle(&self) -> Pixels {
        self.top + self.height / 2.0
    }
}

fn row_at(layout: &TextLayout, text: &str, y: Pixels) -> Option<Row> {
    let row = layout.row_at_y(y)?;
    let middle = row.top + row.height / 2.0;
    let bounds = layout.bounds();
    let start = index_at(layout, point(bounds.left() - px(1.0e4), middle));
    let mut end = index_at(layout, point(bounds.right() + px(1.0e4), middle));
    if end < text.len() && !text[end..].starts_with('\n') {
        while end > start && text.as_bytes()[end - 1] == b' ' {
            end -= 1;
        }
    }
    Some(Row { start, end: end.max(start), top: row.top, height: row.height })
}

/// The byte of `row` whose caret is nearest the x `goal_x`, in the layout: the character boundary
/// the x is closest to, where `index_for_position` gives the character it is over.
fn index_in_row(layout: &TextLayout, text: &str, row: &Row, goal_x: Pixels) -> usize {
    let over = index_at(layout, point(goal_x, row.middle())).clamp(row.start, row.end);
    if over >= row.end || text[over..].starts_with('\n') {
        return over;
    }
    let after = over + char_len_at(text, over);
    let (Some(left), Some(right)) = (layout.position_for_index(over), layout.position_for_index(after)) else {
        return over;
    };
    if right.y == left.y && goal_x > (left.x + right.x) / 2.0 { after.min(row.end) } else { over }
}

/// The text rects of a range between two positions of one paragraph: the content area of the font
/// for each line the range covers, as a range of a text node reports them. A collapsed range is a
/// caret, the rect with no width. The rects are empty when the text did not paint.
pub fn text_range_rects(
    tree: &RetainedTree,
    window: WindowId,
    start: DomPoint,
    end: DomPoint,
) -> Result<Vec<TextRect>, String> {
    let Some(located) = positions::locate(tree, start.node) else {
        return Ok(Vec::new());
    };
    let paragraph = located.paragraph();
    let (Some(from), Some(to)) = (
        positions::byte_of(paragraph, start.node, start.offset),
        positions::byte_of(paragraph, end.node, end.offset),
    ) else {
        return Err("The two ends of a text range have to be in the same paragraph".to_string());
    };
    let Some(entry) = paint::painted_text_by_key(window, &paragraph.key()) else {
        return Ok(Vec::new());
    };
    let (from, to) = (from.min(to), from.max(to));
    let text: &str = &entry.text;
    if from > text.len() || to > text.len() {
        return Ok(Vec::new());
    }
    let collapsed = start == end;
    let locals: Vec<Bounds<Pixels>> = if collapsed {
        caret_rect(&entry.layout, text, from).into_iter().collect()
    } else if from == to {
        Vec::new()
    } else {
        let Some(font_size) = font_size_at(&entry.layout, text, from) else {
            return Ok(Vec::new());
        };
        inline_bounds::rows(&entry.layout, &(from..to), font_size, &[from..to], false)
            .iter()
            .map(inline_bounds::Row::content_area)
            .collect()
    };
    locals
        .into_iter()
        .map(|local| window_rect(&entry, local).ok_or_else(|| "A transform put a text outside the window".to_string()))
        .collect()
}

fn caret_point(entry: &RegEntry, located: &positions::Located, byte: usize, bias: Bias, x: Pixels) -> Option<CaretPoint> {
    let paragraph = located.paragraph();
    let dom = positions::point_at(paragraph, byte, bias)?;
    let window = to_window(entry, point(x, Pixels::ZERO))?;
    Some(CaretPoint {
        node_id: dom.node as f64,
        container_id: paragraph.container as f64,
        offset: dom.offset as f64,
        x: number(window.x),
    })
}

/// The position at the window point, in the text that is under it or nearest to it.
pub fn caret_position_from_point(tree: &RetainedTree, window: WindowId, x: f64, y: f64) -> Option<CaretPoint> {
    caret_position_among(tree, window, x, y, &|_| true)
}

/// [`caret_position_from_point`] among the paragraphs of the editable text of the editing host `host`,
/// which is where a press or a drag in it puts the caret: text in a `contenteditable="false"` island
/// is not a place for it, and a point outside the host is the nearest place inside. An empty line
/// (`<p><br></p>`) paints no text, so it is not among the paragraphs: it is a place by the box of its
/// block, and the nearest of the two kinds wins. Its position is `(block, 0)`, the one that holds a
/// caret in an empty line ([`super::caret::held_by_empty_line`]); the other positions are in a text.
pub fn caret_position_in_host(tree: &RetainedTree, window: WindowId, host: u64, x: f64, y: f64) -> Option<CaretPoint> {
    let text = paint::painted_text_at_among(window, point(pixels(x), pixels(y)), &|entry| {
        positions::container_of_key(&entry.key).is_some_and(|container| {
            crate::html::editing::is_editable(tree, container) && is_inside(tree, container, host)
        })
    });
    let blank = nearest_blank_line(tree, window, host, x, y);
    match (text, blank) {
        (Some((entry, local, nearness)), blank) if blank.as_ref().is_none_or(|blank| nearness <= blank.nearness) => {
            caret_point_in_text(tree, &entry, local)
        }
        (_, Some(blank)) => Some(blank.point),
        (_, None) => None,
    }
}

fn is_inside(tree: &RetainedTree, id: u64, ancestor: u64) -> bool {
    std::iter::successors(Some(id), |id| tree.elements.get(id).and_then(|element| element.parent)).any(|id| id == ancestor)
}

/// An empty line of an editing host as a place for the caret.
struct BlankLine {
    point: CaretPoint,
    /// Vertical then horizontal distance of the pointer from the line, as the painted texts measure it.
    nearness: (f32, f32),
}

/// The blocks in `host` that are one empty line (a plan of nothing but a [`Child::BlankLine`]) and
/// editable, and the one nearest the window point. Found in the tree and measured by the box the last
/// frame recorded for the block (the content box: the line is all of it), which a replayed frame keeps
/// right, where a registry of paint would have to be replayed too.
fn nearest_blank_line(tree: &RetainedTree, window: WindowId, host: u64, x: f64, y: f64) -> Option<BlankLine> {
    let mut best: Option<BlankLine> = None;
    let mut pending = vec![host];
    while let Some(id) = pending.pop() {
        let Some(element) = tree.elements.get(&id) else { continue };
        let children = || element.children.iter().filter_map(|child| tree.elements.get(child));
        pending.extend(children().filter(|child| !is_raw_text(child)).map(|child| child.id).rev());
        // A line feed is what an empty line is made of, so a block with none has no need of a plan.
        let has_line_feed = children().any(|child| if is_raw_text(child) { child.content.as_deref().is_some_and(|text| text.contains('\n')) } else { child.element_type == "br" });
        if !has_line_feed || !crate::html::editing::is_editable(tree, id) {
            continue;
        }
        let planned = plan_cache::planned(tree, element);
        if !matches!(planned.children.as_slice(), [(Child::BlankLine, _)]) {
            continue;
        }
        let Some(bounds) = crate::automation::get_bounds(window, id).filter(|bounds| !bounds.culled) else { continue };
        let Some((local_x, local_y)) = bounds.to_local(x, y) else { continue };
        let left = bounds.x + bounds.client_left + bounds.padding_left;
        let top = bounds.y + bounds.client_top + bounds.padding_top;
        let right = bounds.x + bounds.width - bounds.border_right - bounds.padding_right;
        let bottom = bounds.y + bounds.height - bounds.border_bottom - bounds.padding_bottom;
        let outside = |value: f64, low: f64, high: f64| if value < low { low - value } else if value > high { value - high } else { 0.0 };
        let nearness = (outside(local_y, top, bottom) as f32, outside(local_x, left, right) as f32);
        if best.as_ref().is_some_and(|best| nearness > best.nearness) {
            continue;
        }
        let Some(line_start) = window_point_from(&bounds.to_window, point(px(left as f32), px(((top + bottom) / 2.0) as f32))) else { continue };
        best = Some(BlankLine { point: CaretPoint { node_id: id as f64, container_id: id as f64, offset: 0.0, x: number(line_start.x) }, nearness });
    }
    best
}

fn caret_position_among(tree: &RetainedTree, window: WindowId, x: f64, y: f64, allow: &dyn Fn(&RegEntry) -> bool) -> Option<CaretPoint> {
    let (entry, local, _) = paint::painted_text_at_among(window, point(pixels(x), pixels(y)), allow)?;
    caret_point_in_text(tree, &entry, local)
}

fn caret_point_in_text(tree: &RetainedTree, entry: &RegEntry, local: Point<Pixels>) -> Option<CaretPoint> {
    let located = positions::locate_key(tree, &entry.key)?;
    let text: &str = &entry.text;
    let row = row_at(&entry.layout, text, local.y.clamp(entry.layout.bounds().top(), entry.layout.bounds().bottom() - px(0.5)))?;
    let byte = index_in_row(&entry.layout, text, &row, local.x);
    let caret = caret_at(&entry.layout, text, byte)?;
    caret_point(entry, &located, byte, Bias::After, caret.x)
}

/// The caret of `node`, `offset` moved along the lines of the painted text. `goal_x` is the window x a
/// run of moves up and down keeps, and the caret's own when it is `None`. The result is `None` where
/// there is no line to go to: at the first line going up, at the last going down.
pub fn move_caret_visually(
    tree: &RetainedTree,
    window: WindowId,
    from: DomPoint,
    op: LineMove,
    goal_x: Option<f64>,
) -> Result<Option<CaretPoint>, String> {
    let Some(located) = positions::locate(tree, from.node) else {
        return Ok(None);
    };
    let paragraph = located.paragraph();
    let Some(byte) = positions::byte_of(paragraph, from.node, from.offset) else {
        return Ok(None);
    };
    let Some(entry) = paint::painted_text_by_key(window, &paragraph.key()) else {
        return Ok(None);
    };
    let layout = &entry.layout;
    let text: &str = &entry.text;
    let unreadable = || "A transform put a text outside the window".to_string();
    let Some(caret) = caret_at(layout, text, byte) else {
        return Ok(None);
    };
    let here = row_at(layout, text, caret.row.top + caret.row.height / 2.0).ok_or_else(unreadable)?;
    match op {
        LineMove::Start | LineMove::End => {
            let (target, bias) = if op == LineMove::Start { (here.start, Bias::After) } else { (here.end, Bias::Before) };
            let x = caret_at(layout, text, target).ok_or_else(unreadable)?.x;
            Ok(caret_point(&entry, &located, target, bias, x))
        }
        LineMove::Up | LineMove::Down => {
            let goal = match goal_x {
                Some(goal) => pixels(goal),
                None => to_window(&entry, point(caret.x, here.middle())).ok_or_else(unreadable)?.x,
            };
            let beyond = if op == LineMove::Up { here.top - px(0.5) } else { here.top + here.height + px(0.5) };
            if let Some(row) = row_at(layout, text, beyond) {
                let x = from_window(&entry, point(goal, to_window(&entry, point(Pixels::ZERO, row.middle())).ok_or_else(unreadable)?.y))
                    .ok_or_else(unreadable)?
                    .x;
                let target = index_in_row(layout, text, &row, x);
                return Ok(caret_point(&entry, &located, target, Bias::After, caret_at(layout, text, target).ok_or_else(unreadable)?.x)
                    .map(|point| CaretPoint { x: number(goal), ..point }));
            }
            Ok(neighbor_line(tree, window, &entry.key, op == LineMove::Up, goal))
        }
    }
}

/// The caret on the first line of the paragraph after `key`, or the last of the one before it, at the
/// window x `goal`.
fn neighbor_line(tree: &RetainedTree, window: WindowId, key: &str, backwards: bool, goal: Pixels) -> Option<CaretPoint> {
    let entries = paint::painted_texts_in_document_order(window);
    let here = entries.iter().position(|entry| &*entry.key == key)?;
    let candidates: Box<dyn Iterator<Item = &RegEntry>> =
        if backwards { Box::new(entries[..here].iter().rev()) } else { Box::new(entries[here + 1..].iter()) };
    for entry in candidates {
        let Some(located) = positions::locate_key(tree, &entry.key) else { continue };
        let layout = &entry.layout;
        let text: &str = &entry.text;
        let bounds = layout.bounds();
        let y = if backwards { bounds.bottom() - px(0.5) } else { bounds.top() + px(0.5) };
        let Some(row) = row_at(layout, text, y) else { continue };
        let Some(window_y) = to_window(entry, point(Pixels::ZERO, row.middle())) else { continue };
        let Some(local) = from_window(entry, point(goal, window_y.y)) else { continue };
        let target = index_in_row(layout, text, &row, local.x);
        let Some(caret) = caret_at(layout, text, target) else { continue };
        let found = caret_point(entry, &located, target, Bias::After, caret.x)?;
        return Some(CaretPoint { x: number(goal), ..found });
    }
    None
}
