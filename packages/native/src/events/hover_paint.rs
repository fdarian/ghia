//! Whether a hover only changes how an element paints.
//!
//! A hover that restyles builds the elements it restyled again. When the only properties its
//! refinement changes are ones that change what the element paints (a colour, an opacity that
//! keeps the element in the same kind of layer, the colour of a shadow), the new build lays out
//! as the one before did, registers what it registered and paints the same operations with other
//! values, and a patch frame can write it over the frame shown (`docs/fork/patch-frames.md`,
//! "Hover patches"). Anything else, a size, a font, a transform, a cursor, a transition that
//! would start, is for a frame built whole.
//!
//! The comparison is made on the styles the refinement resolves to, not on the refinement: it
//! copies the paint properties of the style with the state onto the one without, and the two must
//! be equal after that, so a property this module does not know about is not paint-only.

use crate::color::{ColorContext, Scheme};
use crate::css::length::LengthContext;
use crate::events::state_styles::{resolve_pointer_states, PointerStates};
use crate::retained_tree::RetainedTree;
use crate::style::{BackgroundValue, StyleDesc};

/// The most elements a group's followers are looked for among, and the most that a changed `color`
/// is checked to reach: a unit holds no more (`retain::UNIT_MAX_ELEMENTS`), so a group bigger than
/// this one cannot be repainted by a patch anyway.
const WALK_LIMIT: usize = 256;

/// Whether the `hover` refinement of `style` only changes how the element paints. The element
/// has to be in `tree` for its `color` to be followed to the elements that inherit it.
pub(crate) fn hover_paints_only(tree: &RetainedTree, id: u64, style: &StyleDesc) -> bool {
    paints_only(tree, id, style, PointerStates { hovered: true, ..Default::default() })
}

/// Whether the `hasHover` refinement of `style` (`:has(:hover)`) only changes how the element paints.
pub(crate) fn has_hover_paints_only(tree: &RetainedTree, id: u64, style: &StyleDesc) -> bool {
    paints_only(tree, id, style, PointerStates { has_hovered: true, ..Default::default() })
}

/// Whether the hover of the element `id`, which declares a group, only changes how it and the
/// elements that follow it paint. The followers are the elements below it with a `groupHover`
/// style of the group's name, and every one of them has to paint only; a bigger subtree than a
/// unit holds is not looked through, and is not paint-only.
pub(crate) fn group_paints_only(tree: &RetainedTree, id: u64, style: &StyleDesc) -> bool {
    let Some(name) = style.declared_group() else {
        return true;
    };
    let states = PointerStates { group_hovered: true, ..Default::default() };
    let mut seen = 0;
    let mut pending: Vec<u64> = tree.elements.get(&id).map(|element| element.children.to_vec()).unwrap_or_default();
    while let Some(below) = pending.pop() {
        seen += 1;
        if seen > WALK_LIMIT {
            return false;
        }
        let Some(element) = tree.elements.get(&below) else {
            continue;
        };
        if let Some(follower) = element.style.as_deref() {
            if follower.group_hover.is_some()
                && follower.followed_group() == name
                && !paints_only(tree, below, follower, states)
            {
                return false;
            }
        }
        pending.extend(element.children.iter().copied());
    }
    true
}

fn paints_only(tree: &RetainedTree, id: u64, style: &StyleDesc, states: PointerStates) -> bool {
    let off = resolve_pointer_states(style, PointerStates::default());
    let on = resolve_pointer_states(style, states);
    if declares_transition(&off) || declares_transition(&on) {
        return false;
    }
    if !differs_by_paint_only(&off, &on) {
        return false;
    }
    // A colour is inherited, and a transition below the element would start from the old one.
    off.color == on.color || reaches_no_transition(tree, id)
}

fn declares_transition(style: &StyleDesc) -> bool {
    style.transition.is_some()
        || style.transition_property.is_some()
        || style.transition_duration.is_some()
        || style.transition_timing_function.is_some()
        || style.transition_delay.is_some()
        || style.transition_behavior.is_some()
}

/// Whether no element below `id` declares a transition. More elements than a unit holds say no.
fn reaches_no_transition(tree: &RetainedTree, id: u64) -> bool {
    let mut seen = 0;
    let mut pending: Vec<u64> = tree.elements.get(&id).map(|element| element.children.to_vec()).unwrap_or_default();
    while let Some(below) = pending.pop() {
        seen += 1;
        if seen > WALK_LIMIT {
            return false;
        }
        let Some(element) = tree.elements.get(&below) else {
            continue;
        };
        if element.style.as_deref().is_some_and(|style| {
            declares_transition(style)
                || style.hover.as_deref().is_some_and(declares_transition)
                || style.group_hover.as_deref().is_some_and(declares_transition)
                || style.has_hover.as_deref().is_some_and(declares_transition)
        }) {
            return false;
        }
        pending.extend(element.children.iter().copied());
    }
    true
}

/// Whether `on` is `off` with some paint properties set otherwise.
fn differs_by_paint_only(off: &StyleDesc, on: &StyleDesc) -> bool {
    if !opacity_keeps_layer(off.opacity, on.opacity)
        || !shadow_keeps_geometry(off, on)
        || !background_is_colour(off)
        || !background_is_colour(on)
        || !border_keeps_boxes(off, on)
        || !outline_keeps_box(off, on)
    {
        return false;
    }
    let mut probe = off.clone();
    probe.background_color = on.background_color.clone();
    probe.background = on.background.clone();
    probe.color = on.color.clone();
    probe.opacity = on.opacity;
    probe.box_shadow = on.box_shadow.clone();
    probe.outline_color = on.outline_color.clone();
    probe.outline = on.outline.clone();
    probe.text_decoration_color = on.text_decoration_color.clone();
    macro_rules! copy_borders {
        ($($field:ident),+) => { $(probe.$field = on.$field.clone();)+ };
    }
    copy_borders!(
        border, border_block, border_inline, border_top, border_right, border_bottom, border_left, border_color,
        border_top_color, border_right_color, border_bottom_color, border_left_color, border_width,
        border_top_width, border_right_width, border_bottom_width, border_left_width, border_style,
        border_top_style, border_right_style, border_bottom_style, border_left_style
    );
    probe == *on
}

/// A value below 1 makes the element a layer of its own, so crossing 1 changes what is painted
/// in kind, not in value.
fn opacity_keeps_layer(off: Option<f64>, on: Option<f64>) -> bool {
    let layer = |opacity: Option<f64>| opacity.is_some_and(|opacity| opacity < 1.0);
    layer(off) == layer(on)
}

fn background_is_colour(style: &StyleDesc) -> bool {
    matches!(style.background, None | Some(BackgroundValue::Color(_)))
}

/// A shadow with the same layers, offsets, blurs, spreads and insets.
fn shadow_keeps_geometry(off: &StyleDesc, on: &StyleDesc) -> bool {
    match (&off.box_shadow, &on.box_shadow) {
        (None, None) => true,
        (Some(off), Some(on)) => {
            let (off, on) = (off.as_slice(), on.as_slice());
            off.len() == on.len()
                && off.iter().zip(on).all(|(off, on)| {
                    off.offset_x == on.offset_x
                        && off.offset_y == on.offset_y
                        && off.blur_radius == on.blur_radius
                        && off.spread_radius == on.spread_radius
                        && off.inset == on.inset
                })
        }
        _ => false,
    }
}

/// The border of every side keeps its style and its width.
fn border_keeps_boxes(off: &StyleDesc, on: &StyleDesc) -> bool {
    let colors = ColorContext::root(Scheme::Light);
    let lengths = LengthContext::initial(0.0, 0.0);
    let (off, on) = (
        crate::css::border::sides(off, &colors, &lengths),
        crate::css::border::sides(on, &colors, &lengths),
    );
    off.iter().zip(&on).all(|(off, on)| off.style == on.style && off.width == on.width)
}

fn outline_keeps_box(off: &StyleDesc, on: &StyleDesc) -> bool {
    match (&off.outline, &on.outline) {
        (Some(off), Some(on)) => off.width == on.width && off.style == on.style,
        (None, None) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::StyleDesc;

    fn tree_of(style: StyleDesc) -> (RetainedTree, u64) {
        let mut tree = RetainedTree::new();
        tree.create_element(1, "div".to_string());
        tree.set_root(1);
        tree.set_style(1, std::sync::Arc::new(style));
        (tree, 1)
    }

    fn style(json: &str) -> StyleDesc {
        serde_json::from_str(json).unwrap()
    }

    fn hover_paints(json: &str) -> bool {
        let style = style(json);
        let (tree, id) = tree_of(style.clone());
        hover_paints_only(&tree, id, &style)
    }

    #[test]
    fn a_colour_or_a_shadow_colour_is_paint() {
        assert!(hover_paints(r##"{"backgroundColor":"#fff","hover":{"backgroundColor":"#eee"}}"##));
        assert!(hover_paints(r##"{"hover":{"backgroundColor":"#eee"}}"##));
        assert!(hover_paints(r##"{"hover":{"color":"red","outlineColor":"blue","textDecorationColor":"green"}}"##));
        assert!(hover_paints(r##"{"boxShadow":"0 1px 2px #000","hover":{"boxShadow":"0 1px 2px #f00"}}"##));
        assert!(hover_paints(r##"{"hover":{"background":"#eee"}}"##));
        assert!(hover_paints(r##"{"opacity":0.5,"hover":{"opacity":0.8}}"##));
    }

    #[test]
    fn a_border_colour_is_paint_on_every_side_and_every_spelling() {
        let base = r##""borderBottom":"1px solid #f4f4f5""##;
        assert!(hover_paints(&format!(r##"{{{base},"hover":{{"borderBottomColor":"red"}}}}"##)));
        assert!(hover_paints(&format!(r##"{{{base},"hover":{{"borderColor":"red"}}}}"##)));
        assert!(hover_paints(&format!(r##"{{{base},"hover":{{"borderBottom":"1px solid red"}}}}"##)));
        assert!(hover_paints(r##"{"border":"2px solid #000","hover":{"border":"2px solid #f00"}}"##));
    }

    #[test]
    fn a_width_or_a_style_of_a_border_is_not() {
        assert!(!hover_paints(r##"{"borderBottom":"1px solid red","hover":{"borderBottom":"2px solid red"}}"##));
        assert!(!hover_paints(r##"{"border":"1px solid red","hover":{"borderStyle":"dashed"}}"##));
        assert!(!hover_paints(r##"{"hover":{"border":"1px solid red"}}"##), "a border that appears takes room");
    }

    #[test]
    fn layout_font_transform_and_cursor_are_not() {
        for refinement in [
            r##""padding":4"##,
            r##""width":10"##,
            r##""fontWeight":700"##,
            r##""fontSize":20"##,
            r##""transform":"scale(1.1)""##,
            r##""cursor":"pointer""##,
            r##""display":"none""##,
            r##""gap":4"##,
            r##""backgroundImage":"linear-gradient(red, blue)""##,
            r##""zIndex":3"##,
        ] {
            assert!(!hover_paints(&format!(r##"{{"hover":{{"backgroundColor":"#eee",{refinement}}}}}"##)), "{refinement}");
        }
    }

    #[test]
    fn a_hover_that_sets_a_property_to_the_value_it_has_changes_nothing_else() {
        assert!(hover_paints(r##"{"padding":4,"hover":{"padding":4,"backgroundColor":"#eee"}}"##));
    }

    #[test]
    fn a_shadow_that_moves_or_a_layer_that_appears_is_not() {
        assert!(!hover_paints(r##"{"boxShadow":"0 1px 2px #000","hover":{"boxShadow":"0 2px 2px #000"}}"##));
        assert!(!hover_paints(r##"{"boxShadow":"0 1px 2px #000","hover":{"boxShadow":"0 1px 2px #000, 0 0 4px #f00"}}"##));
        assert!(!hover_paints(r##"{"hover":{"boxShadow":"0 1px 2px #000"}}"##), "a shadow that appears is a primitive more");
    }

    #[test]
    fn an_opacity_that_crosses_one_changes_the_layer() {
        assert!(!hover_paints(r##"{"hover":{"opacity":0.5}}"##));
        assert!(!hover_paints(r##"{"opacity":0.5,"hover":{"opacity":1}}"##));
        assert!(hover_paints(r##"{"hover":{"opacity":1}}"##));
    }

    #[test]
    fn a_transition_declared_on_the_element_or_in_the_refinement_is_not() {
        assert!(!hover_paints(r##"{"transition":"background-color 150ms","hover":{"backgroundColor":"#eee"}}"##));
        assert!(!hover_paints(r##"{"hover":{"backgroundColor":"#eee","transitionDuration":"1s"}}"##));
    }

    #[test]
    fn a_custom_property_a_hover_sets_may_feed_anything() {
        assert!(!hover_paints(r##"{"hover":{"backgroundColor":"#eee","--x":"1px"}}"##));
    }

    fn with_child(style: StyleDesc, child: StyleDesc) -> (RetainedTree, u64) {
        let mut tree = RetainedTree::new();
        tree.create_element(1, "div".to_string());
        tree.create_element(2, "div".to_string());
        tree.set_root(1);
        tree.append_child(1, 2);
        tree.set_style(1, std::sync::Arc::new(style));
        tree.set_style(2, std::sync::Arc::new(child));
        (tree, 1)
    }

    #[test]
    fn a_colour_that_a_transition_below_inherits_is_not_paint() {
        let parent = style(r##"{"hover":{"color":"red"}}"##);
        let (tree, id) = with_child(parent.clone(), style(r##"{"transition":"color 1s"}"##));
        assert!(!hover_paints_only(&tree, id, &parent));
        let (tree, id) = with_child(parent.clone(), style(r##"{"color":"blue"}"##));
        assert!(hover_paints_only(&tree, id, &parent));
        let shadow = style(r##"{"hover":{"backgroundColor":"red"}}"##);
        let (tree, id) = with_child(shadow.clone(), style(r##"{"transition":"color 1s"}"##));
        assert!(hover_paints_only(&tree, id, &shadow), "a background is not inherited");
    }

    #[test]
    fn a_group_is_paint_when_every_follower_is() {
        let group = style(r##"{"group":true}"##);
        let paint = style(r##"{"groupHover":{"backgroundColor":"red"}}"##);
        let layout = style(r##"{"groupHover":{"width":50}}"##);
        let (tree, id) = with_child(group.clone(), paint);
        assert!(group_paints_only(&tree, id, &group));
        let (tree, id) = with_child(group.clone(), layout);
        assert!(!group_paints_only(&tree, id, &group));
    }

    #[test]
    fn a_follower_of_another_group_is_none_of_the_groups_business() {
        let group = style(r##"{"group":"card"}"##);
        let other = style(r##"{"groupHover":{"width":50,"group":"toolbar"}}"##);
        let (tree, id) = with_child(group.clone(), other);
        assert!(group_paints_only(&tree, id, &group));
    }
}
