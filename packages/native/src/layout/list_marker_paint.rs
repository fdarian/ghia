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
use std::rc::Rc;

use gpui::Refineable as _;

use gpui::{
    point, px, size, AnyElement, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement, LayoutId, Pixels,
    Style, StyleRefinement, Styled, TextAlign, Window,
};

use crate::css::list_style::{ListStylePosition, ListStyleType};
use crate::renderer::BuildCtx;
use crate::retained_tree::RetainedElement;
use crate::style::StyleDesc;

use super::list_marker::Marker;

/// How far Blink puts an outside symbol marker from the border box of the item, beyond the
/// ascent of the font (`kCMarkerPaddingPx` and one more for the ink that starts a pixel in).
const OUTSIDE_SYMBOL_GAP: i32 = 8;

/// The width Blink gives the space of a symbol marker, in device pixels, with the ascent
/// `offset` (two thirds of it): the size of the shape and two.
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

/// What an item builds for its marker.
pub(crate) struct Built {
    pub element: AnyElement,
    /// Everything the marker is drawn from that the retention verifier compares.
    pub key: String,
    /// For an `inside` marker, the inline size it takes at the start of the first line of the item,
    /// which its element sets when it is laid out (the font is the one the text style has then).
    pub advance: Option<Rc<Cell<Pixels>>>,
}

/// The marker of the item `element` for the build `ctx`, and the ink it reaches past the item.
pub(crate) fn build(element: &RetainedElement, style: Option<&StyleDesc>, ctx: &mut BuildCtx) -> Option<Built> {
    let marker = super::list_marker::marker_of(ctx.tree, &mut ctx.list_ordinals, element.id)?;
    // The marker is drawn in the colour of the text style the item gives it.
    ctx.inherited.colors.note_read();
    let font_size = ctx.inherited.lengths.font_size as f32;
    ctx.subtree.reach(font_size * (marker.text.chars().count() as f32 + 1.0));
    let border_left = style.map_or(px(0.0), |style| {
        crate::css::border::used_widths(style, &ctx.inherited.colors, &ctx.inherited.lengths)[3]
    });
    let key = format!("{:?} {:?} {:?} {}", marker.list_type, marker.position, border_left, marker.text);
    let advance = (marker.position == ListStylePosition::Inside).then(|| Rc::new(Cell::new(Pixels::ZERO)));
    let outside = marker.position == ListStylePosition::Outside;
    let mut canvas = MarkerElement { marker, border_left, advance: advance.clone(), style: StyleRefinement::default() }
        .absolute()
        .unlifted()
        .w(px(0.0))
        .h(px(0.0));
    if outside {
        // The padding box of the item and not its content box, which the border box is measured from.
        canvas = canvas.left(px(0.0));
    }
    Some(Built { element: canvas.into_any_element(), key, advance })
}

/// The element of a marker: of no size, put where an absolute box with no inset on the block axis is
/// (see the module). It sizes the first line of an `inside` marker from its layout.
struct MarkerElement {
    marker: Marker,
    border_left: Pixels,
    advance: Option<Rc<Cell<Pixels>>>,
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
    scale: f32,
    font_size: Pixels,
    line_height: Pixels,
    line_box: gpui::LineBox,
}

impl Metrics {
    fn of(window: &Window) -> (gpui::TextStyle, Self) {
        let style = window.text_style();
        let scale = window.scale_factor();
        let rem = window.rem_size();
        let font_size = style.font_size.to_pixels(rem);
        let text_system = window.text_system();
        let line_height = text_system.line_height(&style, rem, scale);
        let line_box = text_system.line_box(text_system.resolve_font(&style.font()), font_size, scale);
        (style, Self { scale, font_size, line_height, line_box })
    }

    /// The rounded ascent of the font in device pixels, which Blink sizes a symbol from.
    fn ascent_device(&self) -> i32 {
        (f32::from(self.line_box.ascent) * self.scale).round() as i32
    }
}

/// The inline size an `inside` marker takes, in the item's font.
fn inside_advance(marker: &Marker, style: &gpui::TextStyle, metrics: &Metrics, window: &Window) -> Pixels {
    match marker.list_type {
        ListStyleType::Disc | ListStyleType::Circle | ListStyleType::Square => {
            let font_size_device = (f32::from(metrics.font_size) * metrics.scale).round() as i32;
            px(inside_symbol_advance(metrics.ascent_device(), font_size_device) as f32 / metrics.scale)
        }
        _ => shape(marker, style, metrics, window).width(),
    }
}

fn shape(marker: &Marker, style: &gpui::TextStyle, metrics: &Metrics, window: &Window) -> gpui::ShapedLine {
    let mut run = style.to_run(marker.text.len());
    run.underline = None;
    run.strikethrough = None;
    run.overline = None;
    window.text_system().shape_line(marker.text.clone().into(), metrics.font_size, &[run], None)
}

impl Element for MarkerElement {
    type RequestLayoutState = Style;
    type PrepaintState = ();

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
        if let Some(advance) = &self.advance {
            let (style, metrics) = Metrics::of(window);
            advance.set(inside_advance(&self.marker, &style, &metrics, window));
        }
        let mut style = Style::default();
        style.refine(&self.style);
        (window.request_layout(style.clone(), [], cx), style)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Style,
        _window: &mut Window,
        _cx: &mut gpui::App,
    ) {
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        style: &mut Style,
        _prepaint: &mut (),
        window: &mut Window,
        cx: &mut gpui::App,
    ) {
        style.paint(bounds, window, cx, |window, cx| paint(&self.marker, self.border_left, bounds, window, cx));
    }
}

fn paint(marker: &Marker, border_left: Pixels, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut gpui::App) {
    if window.visibility() != gpui::Visibility::Visible {
        return;
    }
    let (style, metrics) = Metrics::of(window);
    let scale = metrics.scale;
    let (above, _) = metrics.line_box.extent(metrics.line_height, scale);
    let outside = marker.position == ListStylePosition::Outside;
    let edge = if outside { bounds.origin.x - border_left } else { bounds.origin.x };

    match marker.list_type {
        ListStyleType::Disc | ListStyleType::Circle | ListStyleType::Square => {
            let symbol = Symbol::of(metrics.ascent_device());
            let half_leading = (f32::from(above - metrics.line_box.ascent) * scale).round() as i32;
            let top = (f32::from(bounds.origin.y) * scale).round() as i32 + half_leading + symbol.top;
            let left = (f32::from(edge) * scale).round() as i32 + if outside { 1 - symbol.offset - OUTSIDE_SYMBOL_GAP } else { 0 };
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
            let line = shape(marker, &style, &metrics, window);
            let origin = point(if outside { edge - line.width() } else { edge }, bounds.origin.y);
            // The line is laid out by the line box model of the item; a failed paint has no better answer than none.
            let _ = line.paint(origin, metrics.line_height, TextAlign::Left, None, window, cx);
        }
    }
}
