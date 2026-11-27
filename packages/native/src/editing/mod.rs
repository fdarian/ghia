//! What editing a DOM needs from the painted text: where a DOM position (a text node and an offset)
//! is on screen, which position is at a point, and where a caret goes moving by lines.
//!
//! [`positions`] maps between `Text.data` offsets and the bytes of the paragraph text that is painted
//! (the pure half, with the lookup of a node's paragraph); [`geometry`] reads the last painted frame
//! for the rects, hit tests and line moves JS asks for; [`snapshot`] and [`input_handler`] are the text
//! the platform's text input sees, what it does with typed text and [`composition`], the text an input method has marked;
//! [`pointer`] finds the position under a press or a drag in a host and hands it to JS.

pub mod caret;
pub mod composition;
pub mod geometry;
pub mod input_handler;
pub mod node_selection;
pub mod pointer;
pub mod positions;
pub mod snapshot;

use gpui::WindowId;

use crate::retained_tree::RetainedTree;
use geometry::{CaretPoint, LineMove, TextRect};
use positions::DomPoint;

/// The napi arguments of the three reads, checked and passed on. Both renderers call these once the
/// window has painted what changed (or, from an event handler, as far as it can).
pub(crate) struct Reads<'a> {
    pub tree: &'a RetainedTree,
    pub window: WindowId,
    /// The clock the window blinks its carets by, which the phase of a caret is read from.
    pub now: web_time::Instant,
}

fn offset(value: f64) -> Result<usize, String> {
    if !(value >= 0.0 && value.fract() == 0.0) {
        return Err(format!("{value} is not an offset in the text of an editing host"));
    }
    Ok(value as usize)
}

fn dom_point(node_id: f64, offset: f64) -> Result<DomPoint, String> {
    let node = crate::renderer::raw_element_id(node_id)?;
    if !(offset >= 0.0 && offset.fract() == 0.0) {
        return Err(format!("{offset} is not an offset in a text node"));
    }
    Ok(DomPoint { node, offset: offset as usize })
}

impl Reads<'_> {
    pub(crate) fn text_range_rects(&self, start_node: f64, start_offset: f64, end_node: f64, end_offset: f64) -> Result<Vec<TextRect>, String> {
        geometry::text_range_rects(self.tree, self.window, dom_point(start_node, start_offset)?, dom_point(end_node, end_offset)?)
    }

    /// What the last frame washed and put the caret at for the node selection. Test renderer only.
    pub(crate) fn painted_node_selection(&self) -> node_selection::PaintedNodeSelection {
        node_selection::painted(self.window, self.now)
    }

    /// Where the platform's input method would be told the characters `start..end` of the text input of `host` are.
    /// Test renderer only.
    pub(crate) fn input_method_bounds(&self, host: f64, start: f64, end: f64) -> Result<Option<TextRect>, String> {
        let host = crate::renderer::raw_element_id(host)?;
        let snapshot = snapshot::Snapshot::of(self.tree, host);
        let range = offset(start)?..offset(end)?;
        let bounds = input_handler::range_bounds(self.tree, self.window, snapshot.as_ref(), &range);
        let number = |value: gpui::Pixels| f64::from(f32::from(value));
        Ok(bounds.map(|bounds| TextRect { x: number(bounds.origin.x), y: number(bounds.origin.y), width: number(bounds.size.width), height: number(bounds.size.height) }))
    }

    /// The character offset the platform's input method would be told for a window point. Test renderer only.
    pub(crate) fn input_method_index_at(&self, host: f64, x: f64, y: f64) -> Result<Option<f64>, String> {
        let host = crate::renderer::raw_element_id(host)?;
        let Some(snapshot) = snapshot::Snapshot::of(self.tree, host) else { return Ok(None) };
        let at = gpui::point(gpui::px(x as f32), gpui::px(y as f32));
        Ok(input_handler::index_at_point(self.tree, self.window, &snapshot, at).map(|index| index as f64))
    }

    pub(crate) fn caret_position_from_point(&self, x: f64, y: f64) -> Result<Option<CaretPoint>, String> {
        if !x.is_finite() || !y.is_finite() {
            return Err("caretPositionFromPoint needs finite coordinates".to_string());
        }
        Ok(geometry::caret_position_from_point(self.tree, self.window, x, y))
    }

    pub(crate) fn move_caret_visually(&self, node: f64, offset: f64, op: &str, goal_x: Option<f64>) -> Result<Option<CaretPoint>, String> {
        geometry::move_caret_visually(self.tree, self.window, dom_point(node, offset)?, LineMove::parse(op)?, goal_x)
    }
}
