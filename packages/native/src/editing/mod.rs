//! What editing a DOM needs from the painted text: where a DOM position (a text node and an offset)
//! is on screen, which position is at a point, and where a caret goes moving by lines.
//!
//! [`positions`] maps between `Text.data` offsets and the bytes of the paragraph text that is painted
//! (the pure half, with the lookup of a node's paragraph); [`geometry`] reads the last painted frame
//! for the rects, hit tests and line moves JS asks for; [`snapshot`] and [`input_handler`] are the text
//! the platform's text input sees and what it does with typed text.

pub mod caret;
pub mod geometry;
pub mod input_handler;
pub mod node_selection;
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
        node_selection::painted(self.window)
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
