//! The children a commit put into the content of a scroller, for the frame that moves the content to build where the frame shown
//! has none (`Window::set_scroll_patch_removals`, [`gpui::ScrollEntering`]): which group of them comes in beside which root that
//! stays, and where each is put and how big it comes out, worked out from its style and the box of its parent in the frame shown
//! alone. A child whose place or size needs the parent laid out again is none of these, and the frame is built whole.

use crate::retained_tree::{RetainedElement, RetainedTree};
use crate::style::{DimensionValue, StyleDesc};

/// Where a child that came in is put, and what it is laid out in.
#[derive(Clone)]
pub(crate) struct Placed {
    /// The top left of its box in the window, in the frame shown (the scroll has not moved it).
    pub origin: (f64, f64),
    pub size: (f64, f64),
    /// The width of the padding box of the parent, which the child is laid out in.
    pub available_width: f64,
}

/// Children that came in under `parent` and follow one another in the tree, beside the root `neighbor` that stays.
#[derive(Clone)]
pub(crate) struct Group {
    pub parent: u64,
    pub neighbor: u64,
    /// The group comes after the neighbor in the tree.
    pub follows: bool,
    pub children: Vec<(u64, Placed)>,
}

/// The groups the children `added` (each with its parent) make, or `None` when one of them cannot be built by a scroll.
pub(crate) fn groups(tree: &RetainedTree, window: gpui::WindowId, added: &[(u64, u64)]) -> Option<Vec<Group>> {
    let mut parents: Vec<u64> = added.iter().map(|(_, parent)| *parent).collect();
    parents.sort_unstable();
    parents.dedup();
    let came = |id: &u64| added.iter().any(|(child, _)| child == id);
    let mut groups = Vec::new();
    for parent in parents {
        let siblings = tree.children_of(parent)?;
        // What a parent builds the children it has out of: each is a block of its own, whose index among its siblings is its place in
        // the document.
        let blocks = siblings.iter().all(|id| {
            tree.elements
                .get(id)
                .is_some_and(|element| element.element_type != "#text" && tree.position_of(element) == crate::layout::containing_block::Position::Absolute)
        });
        if !blocks {
            return None;
        }
        let bounds = crate::automation::get_bounds(window, parent)?;
        if bounds.is_transformed() {
            return None;
        }
        // The horizontal place of a box that names none is where its parent's content begins, when the parent is a block.
        let auto_left = tree
            .elements
            .get(&parent)
            .and_then(|holder| holder.style.as_deref())
            .is_none_or(|style| matches!(style.display.as_deref(), None | Some("block")))
            .then_some(bounds.padding_left);
        let holder = (
            bounds.x + bounds.client_left,
            bounds.y + bounds.client_top,
            bounds.width - bounds.client_left - bounds.border_right,
            bounds.height - bounds.client_top - bounds.border_bottom,
        );
        let mut at = 0;
        while at < siblings.len() {
            if !came(&siblings[at]) {
                at += 1;
                continue;
            }
            let first = at;
            while at < siblings.len() && came(&siblings[at]) {
                at += 1;
            }
            let (neighbor, follows) = match first.checked_sub(1) {
                Some(before) => (siblings[before], true),
                None => (*siblings.get(at)?, false),
            };
            let children = siblings[first..at]
                .iter()
                .map(|id| Some((*id, placed(tree.elements.get(id)?, holder, auto_left)?)))
                .collect::<Option<Vec<_>>>()?;
            groups.push(Group { parent, neighbor, follows, children });
        }
    }
    Some(groups)
}

/// Where the absolute child `element` is put in its parent, whose padding box is `holder` (x, y, width, height), and the size it comes
/// out at, if its style says both in lengths: nothing the layout of what holds it would decide, and inside the padding box, so that
/// the scrollable overflow of what holds it stays.
fn placed(element: &RetainedElement, holder: (f64, f64, f64, f64), auto_left: Option<f64>) -> Option<Placed> {
    let style = element.style.as_deref()?;
    if !has_a_box_of_its_own_size(style) {
        return None;
    }
    let along = |value: &Option<DimensionValue>, of: f64| match value {
        Some(DimensionValue::Pixels(pixels)) => Some(*pixels),
        Some(DimensionValue::Percentage(fraction)) => Some(fraction * of),
        _ => None,
    };
    let left = match style.left {
        None | Some(DimensionValue::Auto) => auto_left?,
        _ => along(&style.left, holder.2)?,
    };
    let top = along(&style.top, holder.3)?;
    let (width, height) = (along(&style.width, holder.2)?, along(&style.height, holder.3)?);
    const SLACK: f64 = 0.01;
    let inside = left >= -SLACK && top >= -SLACK && left + width <= holder.2 + SLACK && top + height <= holder.3 + SLACK;
    (inside && width > 0.0 && height > 0.0).then_some(Placed {
        origin: (holder.0 + left, holder.1 + top),
        size: (width, height),
        available_width: holder.2,
    })
}

/// Whether nothing in the style of a child makes its box other than the lengths it declares for its size and its place: no margin
/// around it, no bound on the size, no ratio, no inset it does not name, no other way to be displayed.
fn has_a_box_of_its_own_size(style: &StyleDesc) -> bool {
    let free = |value: &Option<DimensionValue>| matches!(value, None | Some(DimensionValue::Auto));
    // Boxes are border boxes, so what is inside the size is no reason for another: padding and border stay in it.
    style.margin.is_none()
        && style.margin_block.is_none()
        && style.margin_inline.is_none()
        && [&style.margin_top, &style.margin_right, &style.margin_bottom, &style.margin_left].iter().all(|side| side.is_none())
        && [&style.min_width, &style.min_height, &style.max_width, &style.max_height].iter().all(|bound| free(bound))
        && style.aspect_ratio.is_none()
        && style.inset.is_none()
        && style.inset_block.is_none()
        && style.inset_inline.is_none()
        && free(&style.right)
        && free(&style.bottom)
        && style.z_index.is_none()
        && matches!(style.display.as_deref(), None | Some("block" | "flex" | "grid"))
}
