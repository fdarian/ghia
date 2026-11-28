//! The children a commit put into the content of a scroller, for the frame that moves the content to build where the frame shown
//! has none (`Window::set_scroll_patch_removals`, [`gpui::ScrollEntering`]): which group of them comes in beside which root that
//! stays, and where each is put and how big it comes out, worked out from its style and the box of its parent in the frame shown
//! alone. A child whose place or size needs the parent laid out again is none of these, and the frame is built whole.

use crate::renderer::{BuildStart, GpuixView};
use crate::retained_tree::{RetainedElement, RetainedTree};
use crate::style::{DimensionValue, StyleDesc};

/// Where a child that came in is put, and what it is laid out in.
#[derive(Clone)]
pub(crate) struct Placed {
    /// Where its box is, as the layout of the page puts it (the scroll has not moved it).
    pub origin: gpui::ScrollEnteredOrigin,
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
///
/// Where a child is put is not worked out here: the window reads the layout of the parent (`gpui::ScrollEnteredInHolder`) and places
/// the child as taffy does for a frame built whole. What is worked out here is only whether the child is a box the scroll can
/// build, from the area the layout holds the absolute children of the parent in.
pub(crate) fn groups(tree: &RetainedTree, window: &gpui::Window, added: &[(u64, u64)]) -> Option<Vec<Group>> {
    let window_id = window.window_handle().window_id();
    let mut parents: Vec<u64> = added.iter().map(|(_, parent)| *parent).collect();
    parents.sort_unstable();
    parents.dedup();
    let came_ids: rustc_hash::FxHashSet<u64> = added.iter().map(|(child, _)| *child).collect();
    let came = |id: &u64| came_ids.contains(id);
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
        let bounds = crate::automation::get_bounds(window_id, parent)?;
        if bounds.is_transformed() {
            return None;
        }
        let crate::automation::HostBox::Node(node, ..) = crate::automation::HostBox::of(window, parent) else {
            return None;
        };
        let area = window.absolute_area_of(node)?;
        // The horizontal place of a box that names none is where its parent's content begins, when the parent is a block and the
        // inline axis runs from the left (a right-to-left parent puts it at the other end).
        let right_to_left = is_right_to_left(tree, parent)?;
        let auto_left = tree
            .elements
            .get(&parent)
            .filter(|holder| is_block_container(holder))
            .map(|_| bounds.padding_left)
            .filter(|_| !right_to_left);
        let holder = Holder { node, area_width: f64::from(f32::from(area.width)), area_height: f64::from(f32::from(area.height)) };
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
                .map(|id| Some((*id, placed(tree.elements.get(id)?, &holder, auto_left)?)))
                .collect::<Option<Vec<_>>>()?;
            groups.push(Group { parent, neighbor, follows, children });
        }
    }
    Some(groups)
}

/// The parent of the children that came, as the layout of the frame shown has it.
struct Holder {
    /// Its layout node.
    node: gpui::LayoutId,
    /// The area its absolute children are sized against and their percentages are of, in logical pixels.
    area_width: f64,
    area_height: f64,
}

/// A length of the style that the window resolves as layout does, which only a length in px or a percentage is.
fn declared(value: &Option<DimensionValue>) -> Option<gpui::DefiniteLength> {
    match value {
        Some(DimensionValue::Pixels(pixels)) => Some(gpui::px(*pixels as f32).into()),
        Some(DimensionValue::Percentage(fraction)) => Some(gpui::relative(*fraction as f32)),
        _ => None,
    }
}

/// How the absolute child `element` is put in its parent, `holder`, and the size it comes out at, if its style says both in
/// lengths: nothing the layout of what holds it would decide, and inside the area of the parent, so that the scrollable overflow of
/// what holds it stays.
///
/// The lengths here are the ones the checks need, in logical pixels, and may be a hair off what layout resolves; the place is not
/// worked out from them but by the window, from the `top` and `left` as the style names them (`gpui::ScrollEnteredInHolder`).
fn placed(element: &RetainedElement, holder: &Holder, auto_left: Option<f64>) -> Option<Placed> {
    let style = element.style.as_deref()?;
    if !has_a_box_of_its_own_size(style) {
        return None;
    }
    let named_left = !matches!(style.left, None | Some(DimensionValue::Auto));
    // A box that names no left is put where a block of its own would begin: an inline one is put where the line it is in begins.
    if !named_left && !is_block_level(element, style) {
        return None;
    }
    let along = |value: &Option<DimensionValue>, of: f64| match value {
        Some(DimensionValue::Pixels(pixels)) => Some(*pixels),
        Some(DimensionValue::Percentage(fraction)) => Some(fraction * of),
        _ => None,
    };
    let declared_left = match style.left {
        None | Some(DimensionValue::Auto) => None,
        _ => Some(declared(&style.left)?),
    };
    let left = match declared_left {
        None => auto_left?,
        Some(_) => along(&style.left, holder.area_width)?,
    };
    let top = along(&style.top, holder.area_height)?;
    let declared_top = declared(&style.top)?;
    let width = along(&style.width, holder.area_width)?;
    let height = along(&style.height, holder.area_height)?;
    // A transform moves the box and what its parent scrolls over: it has to stay inside the padding box as well.
    let moved = translation(style, (width, height))?;
    const SLACK: f64 = 0.01;
    let left_end = left + moved.0;
    let top_end = top + moved.1;
    let inside = left >= -SLACK
        && top >= -SLACK
        && left_end >= -SLACK
        && top_end >= -SLACK
        && left_end + width <= holder.area_width + SLACK
        && top_end + height <= holder.area_height + SLACK
        && left + width <= holder.area_width + SLACK
        && top + height <= holder.area_height + SLACK;
    (inside && width > 0.0 && height > 0.0).then_some(Placed {
        origin: gpui::ScrollEnteredOrigin::InHolder(gpui::ScrollEnteredInHolder { holder: holder.node, top: declared_top, left: declared_left }),
        size: (width, height),
        available_width: holder.area_width,
    })
}

/// Whether the inline axis of `from` runs from the right, as `direction` inherits; `None` when an element of the way up is not in the
/// tree.
fn is_right_to_left(tree: &RetainedTree, from: u64) -> Option<bool> {
    let mut at = Some(from);
    while let Some(id) = at {
        let element = tree.elements.get(&id)?;
        if let Some(direction) = element.style.as_deref().and_then(|style| style.direction) {
            return Some(direction.is_rtl());
        }
        at = element.parent;
    }
    Some(false)
}

/// Whether `element` is a block that lays out the boxes in its flow one under the other, with the absolute ones that name no left
/// put where its content begins: `display: block`, or no `display` on an element that is one by what it is.
fn is_block_container(element: &RetainedElement) -> bool {
    match element.style.as_deref().and_then(|style| style.display.as_deref()) {
        Some("block") => true,
        None => is_block_type(element),
        Some(_) => false,
    }
}

fn is_block_type(element: &RetainedElement) -> bool {
    matches!(element.element_type.as_str(), "div" | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "li")
}

/// Whether the box of `element` is block-level, as the box it would be in the flow of its parent is.
fn is_block_level(element: &RetainedElement, style: &StyleDesc) -> bool {
    match style.display.as_deref() {
        Some("block" | "flex" | "grid") => true,
        None => is_block_type(element),
        Some(_) => false,
    }
}

/// How far the style moves the box of a child that is `size` big, when what it declares is translations by lengths in px or
/// percentages and no other transform: `None` for any other, which is no translation a scroll can put in the frame.
fn translation(style: &StyleDesc, size: (f64, f64)) -> Option<(f64, f64)> {
    use crate::css::transform;
    if !transform::declares(style) {
        return Some((0.0, 0.0));
    }
    // Lengths that are not px or percentages read the font or the viewport of an element that is not laid out yet.
    const UNITS_OF_OTHERS: [&str; 17] =
        ["em", "ex", "ch", "lh", "cap", "ic", "vw", "vh", "vi", "vb", "vmin", "vmax", "cq", "var(", "calc(", "min(", "max("];
    let texts = [style.transform.as_deref(), style.translate.as_deref()];
    if style.animating_transform
        || style.transform_in_motion
        || style.rotate.is_some()
        || style.scale.is_some()
        || style.motion_transform.is_some()
        || transform::has_motion_keys(style)
        || texts.iter().flatten().any(|text| UNITS_OF_OTHERS.iter().any(|unit| text.contains(unit)))
    {
        return None;
    }
    let element = transform::of(style, &crate::css::length::LengthContext::initial(0.0, 0.0))?;
    let mut moved = (0.0, 0.0);
    for function in &element.functions {
        let gpui::TransformFunction::Translate(x, y) = function else { return None };
        moved.0 += f64::from(x.px) + f64::from(x.fraction) * size.0;
        moved.1 += f64::from(y.px) + f64::from(y.fraction) * size.1;
    }
    Some(moved)
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

impl GpuixView {
    /// Whether `id` scrolls its own content (it has a scroll handle).
    pub(crate) fn is_scroll_container(&self, id: u64) -> bool {
        self.scroll_handles.contains_key(&id)
    }

    /// What the children of `parent` that are absolute and placed by it inside a scroller were built from.
    pub(crate) fn retain_entry_start(&self, parent: u64) -> Option<(&BuildStart, u64)> {
        self.retain.entry_start(parent)
    }

    /// Builds the child `child`, which came into the content of a scroller as the child of its parent at `index`, as the frame that
    /// built its siblings built them (`start`, and the `shape` of the parent), for a frame that moves the content to put in the frame
    /// shown: a root entered the way a row of a list is, which has no part in the decision of the page.
    pub(crate) fn build_entering(
        &mut self,
        child: u64,
        index: u32,
        start: BuildStart,
        shape: u64,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> gpui::AnyElement {
        let tree_arc = self.tree.clone();
        let tree = tree_arc.lock().unwrap();
        let callback = self.event_callback.clone();
        let now = self.pass_instant(window);
        let start = start.for_entering(index, now, self.focus.styles(&tree, tree.keyboard_focus_dim()), window.viewport_size());
        crate::layout::box_generation::hold_display(&tree, self.css_transitions.held_displays());
        crate::accessibility::links::sync(&tree);
        let activation = self.activation();
        let pointer_state = self.pointer.clone();
        let pointer = pointer_state.borrow();
        let mut highlight_events = Vec::new();
        let mut build_ctx = self.build_ctx(&tree, &callback, &activation, &pointer, &mut highlight_events, crate::text::font_family::Fonts::of(cx), start);
        build_ctx.retain.begin_entering(shape);
        let built = crate::renderer::build_element(child, &mut build_ctx, window, cx);
        build_ctx.retain.finish_entering();
        drop(pointer);
        crate::renderer::emit_highlight_events(&callback, &highlight_events);
        self.emit_css_events(&callback, &tree);
        crate::renderer::emit_layout_events(&callback, &tree, self.layout_flips.take_events());
        built
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(json: &str) -> RetainedTree {
        let mut tree = RetainedTree::new();
        crate::batch::test_json::apply(&mut tree, json).expect("valid batch");
        tree
    }

    fn block_container(json: &str) -> bool {
        is_block_container(tree(json).elements.get(&1).expect("element 1"))
    }

    #[test]
    fn only_a_block_puts_a_box_that_names_no_left_where_its_content_begins() {
        assert!(block_container(r##"[["createElement",1,"div"],["setRoot",1]]"##));
        assert!(block_container(r##"[["createElement",1,"span"],["setStyle",1,{"display":"block"}],["setRoot",1]]"##));
        assert!(!block_container(r##"[["createElement",1,"span"],["setRoot",1]]"##), "no display on an inline element");
        assert!(!block_container(r##"[["createElement",1,"div"],["setStyle",1,{"display":"flex"}],["setRoot",1]]"##));
        assert!(!block_container(r##"[["createElement",1,"div"],["setStyle",1,{"display":"inline-block"}],["setRoot",1]]"##));
    }

    #[test]
    fn the_direction_is_inherited_and_unknown_for_an_element_that_is_not_in_the_tree() {
        let ltr = tree(r##"[["createElement",1,"div"],["createElement",2,"div"],["appendChild",1,2],["setRoot",1]]"##);
        assert_eq!(is_right_to_left(&ltr, 2), Some(false));
        let rtl = tree(r##"[["createElement",1,"div"],["setStyle",1,{"direction":"rtl"}],["createElement",2,"div"],["appendChild",1,2],["setRoot",1]]"##);
        assert_eq!(is_right_to_left(&rtl, 2), Some(true));
        assert_eq!(is_right_to_left(&rtl, 99), None);
    }
}
