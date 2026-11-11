//! Boxes whose own size what is in them cannot change: the candidates for a *box root*, a retained root that a
//! commit's layout edit inside it is patched at (`docs/fork/patch-frames.md`, "Box roots").
//!
//! An edit inside such a box lays out again, but the box keeps its border box: the height is definite, and the width is
//! definite or is what the parent stretches an auto width to. So nothing outside it moves, which gpui verifies when it
//! lays the patch out (`PatchDecline::NotContained`); this is a candidacy test and not a proof, and what it lets through
//! that does change the box is a frame built whole.

use crate::retained_tree::{RetainedElement, RetainedTree};
use crate::style::{DimensionValue, StyleDesc};

/// `element`, the box root `id` that runs something that paints (a caret) and so is built by every frame and recorded by
/// none (`Retain::unrecorded_box_root` says which `subtree` it is, if it is one), as a root that gpui records as a source for a
/// patch that lays it out again and never replays: its key is the frame's, as a unit's is. `env` is the build the root
/// keeps for building it again. Anything else is `element` as it is.
pub(crate) fn wrap_unrecorded(
    id: u64,
    subtree: Option<super::cull::Subtree>,
    env: Option<crate::renderer::FrameEnv>,
    element: gpui::AnyElement,
    ctx: &mut crate::renderer::BuildCtx,
) -> gpui::AnyElement {
    use gpui::IntoElement;

    let (Some(subtree), Some(env)) = (subtree, env) else {
        return element;
    };
    let hook = crate::renderer::replay_hook(id, ctx.tapes.clone(), ctx.measurements.clone());
    let retained = gpui::retained(
        crate::renderer::retained_id(id),
        ctx.retain.unit_key(),
        crate::renderer::taped_build(id, element, ctx.tapes.clone()),
    )
    .on_replay_translated(hook)
    .cull_outset(subtree.outset())
    .patchable_relayout();
    ctx.retain.add_box_root(crate::retain::Unit { id, env });
    retained.into_any_element()
}

/// Whether `element` is a plain box that is a candidate for a box root, as far as its own style and its parent's say.
/// What is in it (an excluded element, something lifted, too many elements) and where it is built (a row of a virtual
/// list, inside another root) are judged by `Retain`, which has the build.
pub(crate) fn is_candidate(tree: &RetainedTree, element: &RetainedElement) -> bool {
    if element.element_type != "div" {
        return false;
    }
    let Some(style) = element.style.as_deref() else {
        return false;
    };
    if !has_definite_height(style) || !is_ordinary_box(style) || crate::events::hover_paint::may_lift(style) {
        return false;
    }
    if !has_definite_width(style) && !is_stretched(tree, element, style) {
        return false;
    }
    // A row of a virtual list is laid out as a root of its own, so a patch of it is declined.
    !crate::layout::stacking::is_virtual_row(tree, element)
}

fn is_ordinary_box(style: &StyleDesc) -> bool {
    use crate::events::hover_paint::{has_intrinsic_size, uses_groups};
    // An `@container` rule or a group can give the box another size, display or position than the one declared.
    style.container_rules.is_none()
        && !uses_groups(style)
        && !has_intrinsic_size(style)
        && style.aspect_ratio.is_none()
        && matches!(style.display.as_deref(), None | Some("block" | "flex" | "grid"))
}

/// A length that does not follow its containing block or the content.
fn is_length(value: &DimensionValue) -> bool {
    match value {
        DimensionValue::Pixels(_) => true,
        DimensionValue::Calc(length) => !length.has_percent(),
        DimensionValue::Percentage(_) | DimensionValue::Auto | DimensionValue::Intrinsic(_) | DimensionValue::AnchorSize(_) => false,
    }
}

fn has_definite_height(style: &StyleDesc) -> bool {
    if style.height.as_ref().is_some_and(is_length) {
        return true;
    }
    match (&style.min_height, &style.max_height) {
        (Some(min), Some(max)) => is_length(min) && min == max,
        _ => false,
    }
}

fn has_definite_width(style: &StyleDesc) -> bool {
    style.width.as_ref().is_some_and(is_length)
}

/// An auto width that the parent stretches across its own: a block, or a column flex container whose items stretch.
fn is_stretched(tree: &RetainedTree, element: &RetainedElement, style: &StyleDesc) -> bool {
    if !matches!(style.width, None | Some(DimensionValue::Auto)) || has_auto_inline_margin(style) {
        return false;
    }
    let Some(parent) = element.parent.and_then(|parent| tree.elements.get(&parent)) else {
        return false;
    };
    let Some(parent_style) = parent.style.as_deref() else {
        // A parent with no style is a block.
        return parent.element_type == "div";
    };
    if parent.element_type != "div" || parent_style.container_rules.is_some() {
        return false;
    }
    match parent.display().as_deref() {
        None | Some("block") => true,
        Some("flex") => {
            let column = matches!(parent_style.flex_direction.as_deref(), Some("column" | "column-reverse"));
            let own = style.align_self.as_deref();
            let stretches = |value: Option<&str>| matches!(value, None | Some("stretch" | "normal"));
            // `align-self: auto` takes the parent's `align-items`.
            column && if matches!(own, None | Some("auto")) { stretches(parent_style.align_items.as_deref()) } else { stretches(own) }
        }
        Some(_) => false,
    }
}

fn has_auto_inline_margin(style: &StyleDesc) -> bool {
    let auto = |value: &Option<DimensionValue>| matches!(value, Some(DimensionValue::Auto));
    style.margin.as_ref().is_some_and(|sides| matches!(sides.left, DimensionValue::Auto) || matches!(sides.right, DimensionValue::Auto))
        || style.margin_inline.as_ref().is_some_and(|pair| matches!(pair.start, DimensionValue::Auto) || matches!(pair.end, DimensionValue::Auto))
        || auto(&style.margin_left)
        || auto(&style.margin_right)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn style(json: &str) -> Arc<StyleDesc> {
        Arc::new(serde_json::from_str(json).expect("a style"))
    }

    /// `1 > 2 > 3`, with the styles given for 1 (the parent), 2 (the box asked about) and 3.
    fn page(parent: &str, own: &str) -> RetainedTree {
        let mut tree = RetainedTree::new();
        for (id, parent_id) in [(1, None), (2, Some(1)), (3, Some(2))] {
            tree.create_element(id, "div".to_owned());
            if let Some(parent_id) = parent_id {
                tree.append_child(parent_id, id);
            }
        }
        tree.set_style(1, style(parent));
        tree.set_style(2, style(own));
        tree
    }

    fn candidate(parent: &str, own: &str) -> bool {
        let tree = page(parent, own);
        is_candidate(&tree, tree.elements.get(&2).expect("the box"))
    }

    const COLUMN: &str = r#"{"display": "flex", "flexDirection": "column"}"#;

    #[test]
    fn a_fixed_height_box_that_stretches_across_a_column_or_a_block_is_a_candidate() {
        assert!(candidate(COLUMN, r#"{"height": 56}"#));
        assert!(candidate(r#"{}"#, r#"{"height": 56}"#), "a block parent stretches an auto width");
        assert!(candidate(r#"{"display": "block"}"#, r#"{"height": 56}"#));
        assert!(candidate(COLUMN, r#"{"minHeight": 40, "maxHeight": 40}"#), "min and max height agree");
        assert!(candidate(COLUMN, r#"{"alignSelf": "stretch", "height": 12}"#));
    }

    #[test]
    fn a_definite_width_needs_no_stretch() {
        assert!(candidate(r#"{"display": "flex"}"#, r#"{"width": 200, "height": 56}"#), "a row parent, but the width is declared");
        assert!(candidate(r#"{"display": "flex", "alignItems": "center"}"#, r#"{"width": 200, "height": 56}"#));
    }

    #[test]
    fn a_box_whose_size_follows_its_content_or_its_parent_is_not() {
        assert!(!candidate(COLUMN, r#"{}"#), "no height");
        assert!(!candidate(COLUMN, r#"{"height": "50%"}"#), "a percentage follows the parent");
        assert!(!candidate(COLUMN, r#"{"height": "auto"}"#));
        assert!(!candidate(COLUMN, r#"{"minHeight": 40}"#), "a minimum is not a size");
        assert!(!candidate(COLUMN, r#"{"minHeight": 40, "maxHeight": 41}"#));
        assert!(!candidate(COLUMN, r#"{"height": "fit-content"}"#));
        assert!(!candidate(COLUMN, r#"{"height": "calc(100% - 8px)"}"#));
    }

    #[test]
    fn an_auto_width_that_the_parent_does_not_stretch_is_not() {
        assert!(!candidate(r#"{"display": "flex"}"#, r#"{"height": 56}"#), "a row item is as wide as its content");
        assert!(!candidate(r#"{"display": "flex", "flexDirection": "column", "alignItems": "center"}"#, r#"{"height": 56}"#));
        assert!(!candidate(COLUMN, r#"{"height": 56, "alignSelf": "center"}"#));
        assert!(!candidate(COLUMN, r#"{"height": 56, "marginLeft": "auto"}"#));
        assert!(!candidate(COLUMN, r#"{"height": 56, "marginInline": "auto"}"#));
        assert!(!candidate(r#"{"display": "grid"}"#, r#"{"height": 56}"#));
        assert!(!candidate(COLUMN, r#"{"height": 56, "width": "100%"}"#), "a percentage width follows the parent");
    }

    #[test]
    fn a_box_that_is_placed_lifted_or_sized_by_a_rule_is_not() {
        for own in [
            r#"{"height": 56, "position": "absolute"}"#,
            r#"{"height": 56, "position": "fixed"}"#,
            r#"{"height": 56, "position": "relative"}"#,
            r#"{"height": 56, "zIndex": 2}"#,
            r#"{"height": 56, "opacity": 0.5}"#,
            r#"{"height": 56, "display": "none"}"#,
            r#"{"height": 56, "display": "contents"}"#,
            r#"{"height": 56, "aspectRatio": "1"}"#,
        ] {
            assert!(!candidate(COLUMN, own), "{own}");
        }
    }

    #[test]
    fn only_a_div_is_a_box_root_and_a_row_of_a_virtual_list_is_not() {
        let mut tree = page(COLUMN, r#"{"height": 56}"#);
        tree.create_element(4, "span".to_owned());
        tree.append_child(1, 4);
        tree.set_style(4, style(r#"{"height": 56}"#));
        assert!(!is_candidate(&tree, tree.elements.get(&4).expect("a span")));
        let mut list = page(r#"{}"#, r#"{"height": 56}"#);
        list.create_element(5, "virtual-list".to_owned());
        list.append_child(1, 5);
        list.create_element(6, "div".to_owned());
        list.append_child(5, 6);
        list.set_style(6, style(r#"{"height": 56}"#));
        assert!(!is_candidate(&list, list.elements.get(&6).expect("a row")));
    }
}
