//! Painting the marker of a list item, as Chrome does (`ListMarkerPainter`, `ListMarker`).
//!
//! A marker is no element of the tree and takes no part in layout: the item builds a canvas that
//! is the first of its children, absolute and of no size, and the marker is drawn from its paint
//! with the item's text style, so the font, the colour and the line height are the item's own and
//! the baseline is the one its first line has. The canvas sits where an absolute box with no
//! inset on the block axis does, at the start of the content box of the item, which is the first
//! line when the item holds text or a block whose margin collapses into it; a block that has a
//! margin of its own or another line height has its first line elsewhere and the marker does not
//! follow it ([deviations](../../../../docs/fork/deviations.md)).
//!
//! `disc`, `circle` and `square` are shapes and not glyphs, sized by the ascent of the font in
//! whole device pixels (Blink computes in device pixels on a display of scale 2, so its numbers
//! are of the font as zoomed). The others are the text of the counter, a full stop and a space, in
//! the item's font, and an outside one ends where the item's border box starts.

use std::cell::Cell;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::rc::Rc;

use gpui::Refineable as _;

use gpui::{
    point, px, size, AnyElement, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement, LayoutId, LayoutInsets,
    Pixels, Style, StyleRefinement, Styled, TextAlign, TransformationMatrix, Window,
};

use crate::automation::{record_bounds, LaidOut};
use crate::css::list_style::{ListStylePosition, ListStyleType};
use crate::renderer::BuildCtx;
use crate::retained_tree::RetainedElement;
use crate::style::StyleDesc;

use super::list_marker::Marker;

/// How far Blink puts an outside symbol marker from the border box of the item, beyond the
/// ascent of the font (`kCMarkerPaddingPx` and one more for the ink that starts a pixel in).
const OUTSIDE_SYMBOL_GAP: i32 = 8;

/// The width Blink gives a symbol marker, in device pixels: the size of the shape and two.
fn symbol_width(shape: i32) -> i32 {
    shape + 2
}

/// The geometry of a symbol marker in device pixels, from the rounded ascent of the font.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Symbol {
    /// Two thirds of the ascent, where an outside marker is put from the item.
    offset: i32,
    /// The side of the square, the diameter of the disc.
    shape: i32,
    /// How far under the top of the content area of the line the shape starts.
    top: i32,
}

impl Symbol {
    fn of(ascent: i32) -> Self {
        let offset = ascent * 2 / 3;
        Self { offset, shape: (offset + 1) / 2, top: 3 * (ascent - offset) / 2 }
    }
}

/// The inline size an `inside` symbol marker takes, in device pixels at `font_size` device pixels
/// and `ascent`: the symbol, one em of space after it, less the pixel it starts before the item.
pub(crate) fn inside_symbol_advance(ascent: i32, font_size: i32) -> i32 {
    symbol_width(Symbol::of(ascent).shape) - 1 + font_size
}

/// What an `inside` marker shares with the first paragraph of its item.
#[derive(Clone)]
pub(crate) struct Room {
    /// The inline size the marker takes at the start of the first line, which its element sets when
    /// it is laid out (the font is the one the text style has then).
    pub advance: Rc<Cell<Pixels>>,
    /// Stands for what `advance` comes to in a font: the paragraph is laid out with it, and layout keeps
    /// the measure of a text by its key and not by the advance, which is only known after the build.
    pub width_key: u64,
    /// Where the first row of the paragraph starts in the window, which the paragraph sets when it is
    /// prepainted, ahead of the paint of the marker: alignment moves the marker with the text, as it
    /// moves the room the marker takes at the start of the row. `None` until then.
    pub first_row: Rc<Cell<Option<Pixels>>>,
}

/// Set in the id under which the box of the `outside` marker of an item is recorded with the painted boxes
/// of the window, beside the item's own: `elementsFromPoint` finds the item where its marker is.
const MARKER_BOX: u64 = 1 << 63;

/// The id of the box of the marker of the item `item`.
pub(crate) fn marker_box_id(item: u64) -> u64 {
    item | MARKER_BOX
}

/// The item a box recorded under `id` belongs to: the element itself, or the one whose marker it is.
pub(crate) fn item_of_box(id: u64) -> u64 {
    id & !MARKER_BOX
}

fn record_box(item: u64, hit_box: Bounds<Pixels>, to_window: TransformationMatrix, window: &Window) {
    let laid_out = LaidOut::of_box(hit_box, window.scale_factor()).through(to_window);
    record_bounds(window.window_handle().window_id(), marker_box_id(item), laid_out, hit_box.origin, LayoutInsets::default());
}

/// The device pixel a symbol's shape starts at: from the edge of the item, which an `outside` one is put
/// before by its offset and the gap Blink leaves.
fn symbol_left(edge: Pixels, scale: f32, symbol: &Symbol, outside: bool) -> i32 {
    (f32::from(edge) * scale).round() as i32 + if outside { 1 - symbol.offset - OUTSIDE_SYMBOL_GAP } else { 0 }
}

/// The box of an `outside` marker, which Chrome hit tests: a symbol's is its width a pixel either side of the
/// shape, a counter's is its text and the space after it, ending at the border box of the item, both on the
/// first line.
fn outside_box(marker: &Marker, border_left: Pixels, bounds: Bounds<Pixels>, window: &Window) -> Bounds<Pixels> {
    let metrics = Metrics::of(window);
    let edge = bounds.origin.x - border_left;
    let line = |left: Pixels, width: Pixels| Bounds::new(point(left, bounds.origin.y), size(width, metrics.line_height));
    match marker.list_type {
        ListStyleType::Disc | ListStyleType::Circle | ListStyleType::Square => {
            let symbol = Symbol::of(metrics.ascent_device());
            let device = |value: i32| px(value as f32 / metrics.scale);
            line(device(symbol_left(edge, metrics.scale, &symbol, true) - 1), device(symbol_width(symbol.shape)))
        }
        _ => {
            let width = shape(marker, &metrics, window).width();
            line(edge - width, width)
        }
    }
}

/// What an item builds for its marker.
pub(crate) struct Built {
    pub element: AnyElement,
    /// Everything the marker is drawn from that the retention verifier compares.
    pub key: String,
    pub inside: Option<Room>,
}

/// The marker of the item `element` for the build `ctx`, and the ink it reaches past the item.
pub(crate) fn build(element: &RetainedElement, style: Option<&StyleDesc>, ctx: &mut BuildCtx) -> Option<Built> {
    let marker = super::list_marker::marker_of(ctx.tree, element.id, ctx.inherited.list_style)?;
    // The marker is drawn in the colour of the text style the item gives it.
    ctx.inherited.colors.note_read();
    let font_size = ctx.inherited.lengths.font_size as f32;
    ctx.subtree.reach(font_size * (marker.text.chars().count() as f32 + 1.0));
    let border_left = style.map_or(px(0.0), |style| {
        crate::css::border::used_widths(style, &ctx.inherited.colors, &ctx.inherited.lengths)[3]
    });
    let key = format!("{:?} {:?} {:?} {}", marker.list_type, marker.position, border_left, marker.text);
    let inside = (marker.position == ListStylePosition::Inside).then(|| {
        let mut hasher = DefaultHasher::new();
        format!("{:?}", marker.list_type).hash(&mut hasher);
        marker.text.hash(&mut hasher);
        Room { advance: Rc::new(Cell::new(Pixels::ZERO)), width_key: hasher.finish(), first_row: Rc::new(Cell::new(None)) }
    });
    let outside = marker.position == ListStylePosition::Outside;
    let mut canvas = MarkerElement {
        marker,
        border_left,
        room: inside.clone(),
        hit: !ctx.inherited.pointer_events_none,
        item: element.id,
        style: StyleRefinement::default(),
    }
        .absolute()
        .unlifted()
        .w(px(0.0))
        .h(px(0.0));
    if outside {
        // The padding box of the item and not its content box, which the border box is measured from.
        canvas = canvas.left(px(0.0));
    }
    Some(Built { element: canvas.into_any_element(), key, inside })
}

/// The element of a marker: of no size, put where an absolute box with no inset on the block axis is
/// (see the module). It sizes the first line of an `inside` marker from its layout.
struct MarkerElement {
    marker: Marker,
    border_left: Pixels,
    room: Option<Room>,
    /// Whether the pointer can land on an `outside` marker, which is then the item's own: Chrome's
    /// `elementFromPoint` over the bullet is the `li`, a click there is its click and `li:hover` applies.
    hit: bool,
    item: u64,
    style: StyleRefinement,
}

impl Styled for MarkerElement {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}

impl IntoElement for MarkerElement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

/// The metrics of the text style of the item, as the marker reads them.
struct Metrics {
    style: gpui::TextStyle,
    scale: f32,
    font_size: Pixels,
    line_height: Pixels,
    line_box: gpui::LineBox,
}

impl Metrics {
    fn of(window: &Window) -> Self {
        let style = window.text_style();
        let scale = window.scale_factor();
        let rem = window.rem_size();
        let font_size = style.font_size.to_pixels(rem);
        let text_system = window.text_system();
        let line_height = text_system.line_height(&style, rem, scale);
        let line_box = text_system.line_box(text_system.resolve_font(&style.font()), font_size, scale);
        Self { style, scale, font_size, line_height, line_box }
    }

    /// The rounded ascent of the font in device pixels, which Blink sizes a symbol from.
    fn ascent_device(&self) -> i32 {
        (f32::from(self.line_box.ascent) * self.scale).round() as i32
    }
}

/// The inline size an `inside` marker takes, in the item's font.
fn inside_advance(marker: &Marker, metrics: &Metrics, window: &Window) -> Pixels {
    match marker.list_type {
        ListStyleType::Disc | ListStyleType::Circle | ListStyleType::Square => {
            let font_size_device = (f32::from(metrics.font_size) * metrics.scale).round() as i32;
            px(inside_symbol_advance(metrics.ascent_device(), font_size_device) as f32 / metrics.scale)
        }
        _ => shape(marker, metrics, window).width(),
    }
}

/// The features of the marker: Chrome's `::marker` rule has `font-variant-numeric: tabular-nums`, so
/// the digits of a counter keep one width in a font that has proportional ones. A `tnum` the item
/// sets itself is left as it is.
fn tabular(inherited: &gpui::FontFeatures) -> gpui::FontFeatures {
    let mut features: Vec<(String, u32)> = inherited.tag_value_list().iter().filter(|(tag, _)| tag != "pnum").cloned().collect();
    if !features.iter().any(|(tag, _)| tag == "tnum") {
        features.push(("tnum".to_owned(), 1));
    }
    gpui::FontFeatures(std::sync::Arc::new(features))
}

fn shape(marker: &Marker, metrics: &Metrics, window: &Window) -> gpui::ShapedLine {
    let mut run = metrics.style.to_run(marker.text.len());
    run.underline = None;
    run.strikethrough = None;
    run.overline = None;
    run.font.features = tabular(&run.font.features);
    window.text_system().shape_line(marker.text.clone().into(), metrics.font_size, &[run], None)
}

impl Element for MarkerElement {
    type RequestLayoutState = Style;
    type PrepaintState = Option<Bounds<Pixels>>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn escapes_to(&self) -> Option<gpui::Escape> {
        self.style.escape()
    }

    fn lift_z(&self) -> Option<i32> {
        self.style.lift_z()
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut gpui::App,
    ) -> (LayoutId, Style) {
        if let Some(room) = &self.room {
            let metrics = Metrics::of(window);
            room.advance.set(inside_advance(&self.marker, &metrics, window));
        }
        let mut style = Style::default();
        style.refine(&self.style);
        (window.request_layout(style.clone(), [], cx), style)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Style,
        window: &mut Window,
        _cx: &mut gpui::App,
    ) -> Option<Bounds<Pixels>> {
        if !self.hit || self.marker.position != ListStylePosition::Outside || window.visibility() != gpui::Visibility::Visible {
            return None;
        }
        // The marker has no id of its own, so the hitbox is the item's: the dispatcher takes the host id of the nearest
        // element above it, and the item's own hitbox is its parent, which bounds the offset of the event.
        let hit_box = outside_box(&self.marker, self.border_left, bounds, window);
        window.insert_hitbox(hit_box, gpui::HitboxBehavior::Normal);
        if window.is_layout_pass() {
            let (item, to_window) = (self.item, window.transform());
            window.publish_layout(move |window, _| record_box(item, hit_box, to_window, window));
        }
        Some(hit_box)
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        style: &mut Style,
        prepaint: &mut Option<Bounds<Pixels>>,
        window: &mut Window,
        cx: &mut gpui::App,
    ) {
        if let Some(hit_box) = *prepaint {
            record_box(self.item, hit_box, window.transform(), window);
        }
        let first_row = self.room.as_ref().and_then(|room| room.first_row.get());
        style.paint(bounds, window, cx, |window, cx| paint(&self.marker, self.border_left, first_row, bounds, window, cx));
    }
}

fn paint(
    marker: &Marker,
    border_left: Pixels,
    first_row: Option<Pixels>,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut gpui::App,
) {
    if window.visibility() != gpui::Visibility::Visible {
        return;
    }
    let metrics = Metrics::of(window);
    let style = &metrics.style;
    let scale = metrics.scale;
    let above = metrics.line_box.extent(metrics.line_height, scale).0;
    let outside = marker.position == ListStylePosition::Outside;
    // An inside marker starts the first row of the text, wherever its alignment puts it.
    let edge = if outside { bounds.origin.x - border_left } else { first_row.unwrap_or(bounds.origin.x) };

    match marker.list_type {
        ListStyleType::Disc | ListStyleType::Circle | ListStyleType::Square => {
            let symbol = Symbol::of(metrics.ascent_device());
            let half_leading = (f32::from(above - metrics.line_box.ascent) * scale).round() as i32;
            let top = (f32::from(bounds.origin.y) * scale).round() as i32 + half_leading + symbol.top;
            let left = symbol_left(edge, scale, &symbol, outside);
            let device = |value: f32| px(value / scale);
            let square = Bounds::new(
                point(device(left as f32), device(top as f32)),
                size(device(symbol.shape as f32), device(symbol.shape as f32)),
            );
            match marker.list_type {
                ListStyleType::Disc => window.paint_quad(gpui::quad(
                    square,
                    device(symbol.shape as f32 / 2.0),
                    style.color,
                    0.0,
                    gpui::transparent_black(),
                    gpui::BorderStyle::default(),
                )),
                ListStyleType::Circle => {
                    // Chrome strokes the shape's edge a device pixel wide, which inks a pixel past it all round.
                    let ring = Bounds::new(
                        point(device(left as f32 - 1.0), device(top as f32 - 1.0)),
                        size(device(symbol.shape as f32 + 2.0), device(symbol.shape as f32 + 2.0)),
                    );
                    window.paint_quad(gpui::quad(
                        ring,
                        device((symbol.shape as f32 + 2.0) / 2.0),
                        gpui::transparent_black(),
                        device(1.0),
                        style.color,
                        gpui::BorderStyle::default(),
                    ));
                }
                _ => window.paint_quad(gpui::fill(square, style.color)),
            }
        }
        _ => {
            let line = shape(marker, &metrics, window);
            let origin = point(if outside { edge - line.width() } else { edge }, bounds.origin.y);
            if let Err(error) = line.paint(origin, metrics.line_height, TextAlign::Left, None, window, cx) {
                log::error!("a list marker did not paint: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The numbers headless Chrome paints for Helvetica at 16px and 32px (`list-markers-oracle`): the ink of
    /// a disc is 5 and 10 device pixels wide, 7 and 15 under the top of the content area.
    #[test]
    fn a_symbol_is_sized_from_the_ascent_in_whole_device_pixels() {
        assert_eq!(Symbol::of(14), Symbol { offset: 9, shape: 5, top: 7 });
        assert_eq!(Symbol::of(30), Symbol { offset: 20, shape: 10, top: 15 });
        assert_eq!(Symbol::of(8), Symbol { offset: 5, shape: 3, top: 4 });
    }

    #[test]
    fn an_inside_symbol_takes_its_width_and_a_font_size_less_the_pixel_it_starts_before_the_item() {
        assert_eq!(inside_symbol_advance(14, 16), 22);
        assert_eq!(inside_symbol_advance(30, 32), 43);
        assert_eq!(inside_symbol_advance(8, 9), 13);
    }
}
