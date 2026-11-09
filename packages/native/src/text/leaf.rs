//! A text that is one gpui element.
//!
//! [`selectable_text`](super::selectable_text) wraps the glyphs in a positioned `div` that holds an
//! absolute canvas, which paints the washes and registers the text. For a text that has no other
//! child to place (no ring, opacity group, cursor or region hitbox, focus anchor or atomic inline)
//! the `div` is only the containing block of that canvas, and the canvas only runs two closures
//! around the glyphs. [`TextLeaf`] runs the same two closures around the same glyphs from one
//! element, so a text costs one `Drawable`, one layout node and one dispatch node instead of three
//! of each.
//!
//! What the leaf must keep of the wrapper:
//! - the underlay prepaints before the glyphs and paints under them, as the canvas came first;
//! - it declares the wrapper's cull outset, and in a culled subtree prepaints and paints what the
//!   canvas did there (the glyphs skip their drawing themselves);
//! - it has no id, no hitbox and takes no `note_positioned_capture`, as the wrapper and its
//!   `keeps_no_position` canvas did not;
//! - it enters the identity space the wrapper entered, which only matters inside a `preserve-3d`
//!   or `perspective` parent, where every child is a plane of its own.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

use gpui::{
    AnyElement, App, Bounds, Edges, Element, ElementId, ElementSpace, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, StyledText, Window,
};

use super::paragraph::InlineText;

static ENABLED: LazyLock<AtomicBool> =
    LazyLock::new(|| AtomicBool::new(std::env::var_os("GPUIX_TEXT_LEAF_OFF").is_none()));

/// Whether a text with nothing else to place is built as a [`TextLeaf`]. Off with `GPUIX_TEXT_LEAF_OFF`
/// or `set_enabled(false)` of the test renderer. Read at every build, so flip it before content is
/// mounted: a recording made under one setting is replayed as it was made.
pub(crate) fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub(crate) fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// The glyphs of a text: a run of the inherited style, or a paragraph with a style per run.
pub(super) enum Glyphs {
    Plain(StyledText),
    Paragraph(InlineText),
}

impl Glyphs {
    pub(super) fn into_any(self) -> AnyElement {
        match self {
            Glyphs::Plain(text) => text.into_any_element(),
            Glyphs::Paragraph(text) => text.into_any_element(),
        }
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> LayoutId {
        match self {
            Glyphs::Plain(text) => text.request_layout(id, inspector_id, window, cx).0,
            Glyphs::Paragraph(text) => text.request_layout(id, inspector_id, window, cx).0,
        }
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        culled: bool,
        window: &mut Window,
        cx: &mut App,
    ) {
        match (self, culled) {
            (Glyphs::Plain(text), false) => text.prepaint(id, inspector_id, bounds, &mut (), window, cx),
            (Glyphs::Plain(text), true) => text.prepaint_culled(id, inspector_id, bounds, &mut (), window, cx),
            (Glyphs::Paragraph(text), false) => text.prepaint(id, inspector_id, bounds, &mut (), window, cx),
            (Glyphs::Paragraph(text), true) => text.prepaint_culled(id, inspector_id, bounds, &mut (), window, cx),
        }
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        culled: bool,
        window: &mut Window,
        cx: &mut App,
    ) {
        match (self, culled) {
            (Glyphs::Plain(text), false) => text.paint(id, inspector_id, bounds, &mut (), &mut (), window, cx),
            (Glyphs::Plain(text), true) => text.paint_culled(id, inspector_id, bounds, &mut (), &mut (), window, cx),
            (Glyphs::Paragraph(text), false) => text.paint(id, inspector_id, bounds, &mut (), &mut (), window, cx),
            (Glyphs::Paragraph(text), true) => text.paint_culled(id, inspector_id, bounds, &mut (), &mut (), window, cx),
        }
    }
}

/// A text and the two closures of its underlay, as one element. See the module doc.
pub(super) struct TextLeaf<Prepaint, Paint> {
    glyphs: Glyphs,
    prepaint: Option<Prepaint>,
    paint: Option<Paint>,
    cull_outset: Option<Edges<Pixels>>,
}

impl<Prepaint, Paint> TextLeaf<Prepaint, Paint>
where
    Prepaint: FnOnce(&mut Window) + 'static,
    Paint: FnOnce(&mut Window, &mut App) + 'static,
{
    pub(super) fn new(glyphs: Glyphs, prepaint: Prepaint, paint: Paint, cull_outset: Option<Edges<Pixels>>) -> Self {
        Self { glyphs, prepaint: Some(prepaint), paint: Some(paint), cull_outset }
    }

    fn prepaint_with(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        culled: bool,
        window: &mut Window,
        cx: &mut App,
    ) {
        let underlay = self.prepaint.take().expect("a text leaf is prepainted once");
        let glyphs = &mut self.glyphs;
        window.with_element_space(ElementSpace::default(), |window| {
            underlay(window);
            glyphs.prepaint(id, inspector_id, bounds, culled, window, cx);
        });
    }

    fn paint_with(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        culled: bool,
        window: &mut Window,
        cx: &mut App,
    ) {
        let underlay = self.paint.take().expect("a text leaf is painted once");
        let glyphs = &mut self.glyphs;
        let mut paint = |window: &mut Window| {
            underlay(window, cx);
            glyphs.paint(id, inspector_id, bounds, culled, window, cx);
        };
        if culled {
            paint(window);
        } else {
            window.with_element_space(ElementSpace::default(), paint);
        }
    }
}

impl<Prepaint, Paint> IntoElement for TextLeaf<Prepaint, Paint>
where
    Prepaint: FnOnce(&mut Window) + 'static,
    Paint: FnOnce(&mut Window, &mut App) + 'static,
{
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl<Prepaint, Paint> Element for TextLeaf<Prepaint, Paint>
where
    Prepaint: FnOnce(&mut Window) + 'static,
    Paint: FnOnce(&mut Window, &mut App) + 'static,
{
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn cull_outset(&self) -> Option<Edges<Pixels>> {
        self.cull_outset
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.glyphs.request_layout(id, inspector_id, window, cx), ())
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.prepaint_with(id, inspector_id, bounds, false, window, cx)
    }

    fn prepaint_culled(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.prepaint_with(id, inspector_id, bounds, true, window, cx)
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.paint_with(id, inspector_id, bounds, false, window, cx)
    }

    fn paint_culled(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.paint_with(id, inspector_id, bounds, true, window, cx)
    }
}
