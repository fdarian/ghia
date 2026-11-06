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
//!
//! A patch writes the primitives of an operation over the ones it had, so the operations must be
//! the same ones. gpui paints no quad for a transparent border and no glyph for a transparent
//! text, so a colour that is invisible in one style and visible in the other adds or takes away an
//! operation, and is not paint-only here: it is a frame built whole. The background is the
//! exception: an element whose hover gives it a background keeps its quad when the colour is
//! transparent or there is none (`StyleDesc::keeps_background_quad`), so the quad is there in both
//! styles and the colour is written over it.

use crate::color::{ColorContext, Scheme};
use crate::css::length::LengthContext;
use crate::events::state_styles::{resolve_pointer_states, PointerStates};
use crate::retained_tree::RetainedTree;
use crate::style::{BackgroundValue, StyleDesc};

/// The most elements a root that a hover patch repaints holds. A frame built whole that rebuilds the root builds all
/// of them (what is in it is recorded by no root of its own), so a root is kept to a row, a card or a small
/// control, and a page of cards is not one: its cards are.
pub(crate) const HOVER_ROOT_MAX_ELEMENTS: u32 = 64;

/// The most elements that a changed `color` is checked to reach: a root holds no more.
const WALK_LIMIT: usize = HOVER_ROOT_MAX_ELEMENTS as usize;

/// Whether the `hover` refinement of `style` only changes how the element paints. The element
/// has to be in `tree` for its `color` to be followed to the elements that inherit it.
pub(crate) fn hover_paints_only(tree: &RetainedTree, id: u64, style: &StyleDesc) -> bool {
    paints_only(tree, id, style, PointerStates { hovered: true, ..Default::default() })
}

/// Whether the `hasHover` refinement of `style` (`:has(:hover)`) only changes how the element paints.
pub(crate) fn has_hover_paints_only(tree: &RetainedTree, id: u64, style: &StyleDesc) -> bool {
    paints_only(tree, id, style, PointerStates { has_hovered: true, ..Default::default() })
}

/// Whether an element declares a group or follows one (`groupHover`, `groupActive`, `groupFocusWithin`): the state of a
/// group reaches its followers through the build that reads it, and a root that holds one end of that and not the other
/// is not left unrecorded for a hover patch. A group is a frame built whole.
pub(crate) fn uses_groups(style: &StyleDesc) -> bool {
    style.declared_group().is_some()
        || style.group_hover.is_some()
        || style.group_active.is_some()
        || style.group_focus_within.is_some()
}

/// Whether an element might be lifted out of the root it is in, or lift what is in it: it is positioned, has a
/// `z-index`, an opacity below 1, a transform, a filter, a mask or a clip path, or paints in a layer of its own. A root
/// that lifts something is recorded as a root that hands it to the stacking context around, which a patch of the root
/// as one piece does not repeat, so the roots in it are not left unrecorded for one (see `Retain::paints_hover`).
pub(crate) fn may_lift(style: &StyleDesc) -> bool {
    let set = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.trim().eq_ignore_ascii_case("none"));
    style.position.as_deref().is_some_and(|position| !position.eq_ignore_ascii_case("static"))
        || style.z_index.is_some()
        || style.opacity.is_some_and(|opacity| opacity < 1.0)
        || style.animating_opacity
        || style.animating_transform
        || style.transform_in_motion
        || set(&style.transform)
        || set(&style.translate)
        || set(&style.rotate)
        || set(&style.scale)
        || set(&style.perspective)
        || set(&style.motion_transform)
        || style.x.is_some()
        || style.y.is_some()
        || set(&style.filter)
        || set(&style.backdrop_filter)
        || set(&style.mask)
        || set(&style.mask_image)
        || set(&style.clip_path)
        || style.content_visibility.is_some()
}

/// Whether an element has a size that an intrinsic keyword gives (`min-content`, `max-content`, `fit-content`, `content`):
/// its box is measured under another style than its own and asked for again, and a retained root that holds one is laid
/// out again by every frame unless the box is a root of its own, so it is not left unrecorded for a hover patch.
pub(crate) fn has_intrinsic_size(style: &StyleDesc) -> bool {
    use crate::style::DimensionValue;
    [&style.width, &style.height, &style.min_width, &style.min_height, &style.max_width, &style.max_height, &style.flex_basis]
        .into_iter()
        .any(|size| matches!(size, Some(DimensionValue::Intrinsic(_))))
}

/// Whether a style declares anything a hover of its element could restyle by paint alone, and
/// nothing a hover would restyle otherwise. The flag a build gives its element for a root that
/// holds it to be patchable ahead of the hover: it says nothing of which hover happens.
pub(crate) fn declares_paint_hover(tree: &RetainedTree, id: u64, style: &StyleDesc) -> bool {
    let declares = style.hover.is_some() || style.has_hover.is_some();
    declares
        && style.container_rules.is_none()
        && !uses_groups(style)
        && (style.hover.is_none() || hover_paints_only(tree, id, style))
        && (style.has_hover.is_none() || has_hover_paints_only(tree, id, style))
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
        || !colours_keep_visibility(off, on)
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

/// Whether `value` paints anything: a colour with some alpha. None for one that does not resolve
/// (a `var()`), which only an equal one is.
fn paints(value: Option<&str>) -> Option<bool> {
    match value {
        None => Some(false),
        Some(value) => ColorContext::root(Scheme::Light).resolve(value).map(|colour| colour.a > 0.0),
    }
}

/// Whether the colour of a property is visible in both styles or in neither, or is written the
/// same way. A glyph and a shadow of a transparent colour are not painted either.
fn same_visibility(off: Option<&str>, on: Option<&str>) -> bool {
    match (paints(off), paints(on)) {
        (Some(off), Some(on)) => off == on,
        _ => off == on,
    }
}

fn colours_keep_visibility(off: &StyleDesc, on: &StyleDesc) -> bool {
    let colour = |style: &StyleDesc| match &style.background {
        Some(BackgroundValue::Color(colour)) => Some(colour.clone()),
        _ => style.background_color.clone(),
    };
    let (off_background, on_background) = (colour(off), colour(on));
    // A text with no colour of its own inherits one, which paints.
    let text = |style: &StyleDesc| style.color.clone().unwrap_or_else(|| "black".to_owned());
    (background_quad_kept(off, on, off_background.as_deref(), on_background.as_deref())
        || same_visibility(off_background.as_deref(), on_background.as_deref()))
        && same_visibility(Some(&text(off)), Some(&text(on)))
        && same_visibility(off.outline_color.as_deref(), on.outline_color.as_deref())
        && same_visibility(
            off.outline.as_ref().map(|outline| outline.color.as_str()),
            on.outline.as_ref().map(|outline| outline.color.as_str()),
        )
        && same_visibility(off.text_decoration_color.as_deref(), on.text_decoration_color.as_deref())
        && borders_keep_visibility(off, on)
        && shadows_keep_visibility(off, on)
}

/// Whether the background quad is painted in both styles whatever the colours are: the element keeps it
/// (`StyleDesc::keeps_background_quad`), so one that has no colour, or a transparent one, still paints a
/// quad that a colour is written over. Both colours have to be plain ones that resolve, and the colour
/// confined to no box (`background-clip: text` makes it a layer of its own).
fn background_quad_kept(off: &StyleDesc, on: &StyleDesc, off_colour: Option<&str>, on_colour: Option<&str>) -> bool {
    off.keeps_background
        && on.keeps_background
        && off.background_clip.is_none()
        && on.background_clip.is_none()
        && paints(off_colour).is_some()
        && paints(on_colour).is_some()
}

fn borders_keep_visibility(off: &StyleDesc, on: &StyleDesc) -> bool {
    let colors = ColorContext::root(Scheme::Light);
    let lengths = LengthContext::initial(0.0, 0.0);
    let (off, on) = (
        crate::css::border::sides(off, &colors, &lengths),
        crate::css::border::sides(on, &colors, &lengths),
    );
    // A side with no width or no line paints nothing whatever its colour is.
    let drawn = |side: &crate::css::border::SideBorder| f32::from(side.width) > 0.0 && side.style != crate::css::border::LineStyle::None;
    off.iter().zip(&on).all(|(off, on)| {
        let (off_drawn, on_drawn) = (drawn(off), drawn(on));
        off_drawn == on_drawn && (!off_drawn || off.color.is_transparent() == on.color.is_transparent())
    })
}

fn shadows_keep_visibility(off: &StyleDesc, on: &StyleDesc) -> bool {
    match (&off.box_shadow, &on.box_shadow) {
        (Some(off), Some(on)) => off
            .as_slice()
            .iter()
            .zip(on.as_slice())
            .all(|(off, on)| same_visibility(Some(&off.color), Some(&on.color))),
        _ => true,
    }
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
        assert!(hover_paints(r##"{"background":"#fff","hover":{"background":"#eee"}}"##));
        assert!(hover_paints(r##"{"hover":{"color":"red"}}"##));
        assert!(hover_paints(r##"{"outlineColor":"red","textDecorationColor":"red","hover":{"outlineColor":"blue","textDecorationColor":"green"}}"##));
        assert!(hover_paints(r##"{"boxShadow":"0 1px 2px #000","hover":{"boxShadow":"0 1px 2px #f00"}}"##));
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
            assert!(!hover_paints(&format!(r##"{{"backgroundColor":"#fff","hover":{{"backgroundColor":"#eee",{refinement}}}}}"##)), "{refinement}");
        }
    }

    #[test]
    fn a_hover_that_sets_a_property_to_the_value_it_has_changes_nothing_else() {
        assert!(hover_paints(r##"{"padding":4,"backgroundColor":"#fff","hover":{"padding":4,"backgroundColor":"#eee"}}"##));
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
        assert!(!hover_paints(r##"{"backgroundColor":"#fff","transition":"background-color 150ms","hover":{"backgroundColor":"#eee"}}"##));
        assert!(!hover_paints(r##"{"backgroundColor":"#fff","hover":{"backgroundColor":"#eee","transitionDuration":"1s"}}"##));
    }

    #[test]
    fn a_custom_property_a_hover_sets_may_feed_anything() {
        assert!(!hover_paints(r##"{"backgroundColor":"#fff","hover":{"backgroundColor":"#eee","--x":"1px"}}"##));
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
        let parent = style(r##"{"color":"blue","hover":{"color":"red"}}"##);
        let (tree, id) = with_child(parent.clone(), style(r##"{"transition":"color 1s"}"##));
        assert!(!hover_paints_only(&tree, id, &parent));
        let (tree, id) = with_child(parent.clone(), style(r##"{"color":"blue"}"##));
        assert!(hover_paints_only(&tree, id, &parent));
        let shadow = style(r##"{"backgroundColor":"blue","hover":{"backgroundColor":"red"}}"##);
        let (tree, id) = with_child(shadow.clone(), style(r##"{"transition":"color 1s"}"##));
        assert!(hover_paints_only(&tree, id, &shadow), "a background is not inherited");
    }

    #[test]
    fn a_style_is_flagged_for_a_patchable_root_when_all_it_declares_is_paint() {
        let paint = style(r##"{"backgroundColor":"#fff","hover":{"backgroundColor":"#eee"}}"##);
        let (tree, id) = tree_of(paint.clone());
        assert!(declares_paint_hover(&tree, id, &paint));
        let layout = style(r##"{"hover":{"width":4}}"##);
        let (tree, id) = tree_of(layout.clone());
        assert!(!declares_paint_hover(&tree, id, &layout));
        let none = style(r##"{"backgroundColor":"#eee"}"##);
        let (tree, id) = tree_of(none.clone());
        assert!(!declares_paint_hover(&tree, id, &none));
    }

    #[test]
    fn a_colour_that_appears_or_goes_is_an_operation_more_or_less() {
        // gpui paints no glyph or shadow of a colour with no alpha, nor a quad for a border.
        assert!(!hover_paints(r##"{"color":"red","hover":{"color":"transparent"}}"##), "a text that goes");
        assert!(!hover_paints(r##"{"borderBottom":"1px solid transparent","hover":{"borderBottomColor":"red"}}"##));
        assert!(!hover_paints(r##"{"boxShadow":"0 1px 2px transparent","hover":{"boxShadow":"0 1px 2px #f00"}}"##));
        assert!(!hover_paints(r##"{"outlineColor":"transparent","hover":{"outlineColor":"red"}}"##));
        assert!(hover_paints(r##"{"backgroundColor":"#fff","hover":{"backgroundColor":"rgba(0, 0, 0, 0.1)"}}"##), "alpha is some");
        assert!(hover_paints(r##"{"backgroundColor":"transparent","hover":{"backgroundColor":"rgba(0, 0, 0, 0)"}}"##));
    }

    #[test]
    fn a_background_that_appears_or_goes_is_paint_because_the_quad_is_kept() {
        assert!(hover_paints(r##"{"hover":{"backgroundColor":"#eee"}}"##), "a background that appears");
        assert!(hover_paints(r##"{"hover":{"background":"#eee"}}"##));
        assert!(hover_paints(r##"{"backgroundColor":"#eee","hover":{"backgroundColor":"transparent"}}"##));
        assert!(hover_paints(r##"{"backgroundColor":"transparent","hover":{"backgroundColor":"#eee"}}"##));
        assert!(hover_paints(r##"{"hasHover":{"backgroundColor":"#eee"}}"##));
        // The row of the Mailbox bench: a border and no background, which the hover gives.
        assert!(hover_paints(
            r##"{"position":"relative","height":72,"borderBottom":"1px solid #F4F4F5","userSelect":"none","hover":{"backgroundColor":"#F4F4F5"}}"##
        ));
    }

    #[test]
    fn a_background_that_is_more_than_a_colour_is_still_an_operation_more_or_less() {
        // The colour of `background-clip: text` is a layer of its own, and a value that is not a colour a layer.
        assert!(!hover_paints(r##"{"backgroundClip":"text","hover":{"backgroundColor":"#eee"}}"##));
        assert!(!hover_paints(r##"{"hover":{"background":"url(a.png) #eee"}}"##));
        assert!(!hover_paints(r##"{"hover":{"backgroundImage":"linear-gradient(red, blue)"}}"##));
    }

    #[test]
    fn only_an_element_whose_hover_sets_a_background_keeps_the_quad() {
        assert!(style(r##"{"hover":{"backgroundColor":"#eee"}}"##).keeps_background_quad());
        assert!(style(r##"{"hasHover":{"background":"#eee"}}"##).keeps_background_quad());
        assert!(!style(r##"{"backgroundColor":"#eee"}"##).keeps_background_quad());
        assert!(!style(r##"{"hover":{"color":"red"}}"##).keeps_background_quad());
        assert!(!style(r##"{"active":{"backgroundColor":"#eee"},"groupHover":{"backgroundColor":"#eee"}}"##).keeps_background_quad());
        // The style folded from it remembers, with the hover folded in or away.
        let declared = style(r##"{"hover":{"backgroundColor":"#eee"}}"##);
        assert!(resolve_pointer_states(&declared, PointerStates::default()).keeps_background_quad());
        assert!(resolve_pointer_states(&declared, PointerStates { hovered: true, ..Default::default() }).keeps_background_quad());
    }

    #[test]
    fn what_lifts_or_forms_a_layer_might_lift() {
        for lifting in [
            r##"{"position":"relative"}"##,
            r##"{"position":"absolute"}"##,
            r##"{"zIndex":1}"##,
            r##"{"opacity":0.5}"##,
            r##"{"transform":"scale(2)"}"##,
            r##"{"filter":"blur(2px)"}"##,
            r##"{"clipPath":"circle(50%)"}"##,
        ] {
            assert!(may_lift(&style(lifting)), "{lifting}");
        }
        for plain in [r##"{"position":"static"}"##, r##"{"opacity":1}"##, r##"{"transform":"none"}"##, r##"{"backgroundColor":"red"}"##] {
            assert!(!may_lift(&style(plain)), "{plain}");
        }
    }
}
