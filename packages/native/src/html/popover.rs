//! The HTML popover API: an element with a `popover` attribute is hidden until `showPopover()`
//! opens it, and an open one is drawn in the top layer.
//!
//! Two props of the element say all of it. `popover` is the attribute (`auto`, `manual`, or `""`
//! for `auto`), which JS forwards like any universal prop. `popoverOpen` is not an attribute: JS
//! writes it straight to native when it shows or hides the popover, so no attribute read
//! (`getAttribute`, `getAttributeNames`, `cloneNode`) can see it. Its value is the show order, a
//! number that grows with every show, so of two open popovers the later one is on top.
//!
//! What native does with them:
//! - the user agent style of a popover (Chrome's `[popover]` rules) goes between the style of its
//!   tag and the universal style, so an author style overrides it: `display: none` while closed,
//!   a `position: fixed` box centred in the window while open ([`user_agent`]);
//! - an open popover is built inside a deferred draw in window space, above every `anchored`
//!   layer, in show order ([`into_top_layer`]); hit testing orders it the same way
//!   (`RetainedTree::elements_at`).

use std::sync::{Arc, Mutex, OnceLock};

use rustc_hash::FxHashMap;

use crate::retained_tree::RetainedElement;
use crate::style::StyleDesc;

/// The `popover` attribute, forwarded as a custom prop.
pub(crate) const ATTRIBUTE_PROP: &str = "popover";

/// The show order of an open popover, written by `showPopover()`; absent while closed.
pub(crate) const OPEN_PROP: &str = "popoverOpen";

/// Above the priority of every `anchored` layer (a `Dialog` is 0, a `Select` or a `Tooltip` 1).
const TOP_LAYER_PRIORITY: usize = 1 << 20;

/// Chrome's `[popover]` rules, which apply whether the popover is open or not. `Canvas` and `CanvasText` follow the
/// `color-scheme` of the element, as they do there: `light-dark()` is the same lookup.
///
/// Not what Chrome has in two places, because two things lay out differently here. `width:
/// fit-content` on a fixed box leaves `margin: auto` no free space to take, so the box sits at the
/// left; `max-content` capped by `max-width: 100%` is the same width and is centred. And `height:
/// fit-content` is `auto`, which a fixed box with both `top` and `bottom` stretches to the window, so
/// `inset: 0` is `bottom: auto` here and a popover with no declared `top` is at the top of the
/// window, centred across.
macro_rules! rules {
    () => {
        r##""position":"fixed","top":0,"right":0,"bottom":"auto","left":0,"width":"max-content","maxWidth":"100%","height":"fit-content","margin":"auto","borderWidth":3,"borderStyle":"solid","borderColor":"currentColor","padding":"0.25em","overflow":"auto","color":"light-dark(#000000, #ffffff)","backgroundColor":"light-dark(#ffffff, #121212)""##
    };
}

const OPEN_STYLE: &str = concat!("{", rules!(), "}");

/// Chrome's `[popover]:not(:popover-open) { display: none }` only adds to the rules above: a closed
/// popover that an author style shows (`display: block`) is still the fixed, bordered box.
const CLOSED_STYLE: &str = concat!(r#"{"display":"none","#, rules!(), "}");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// Light dismiss, and showing one hides the others that are not its ancestors. `""`, `auto`
    /// and `hint`.
    Auto,
    /// Neither: only `hidePopover()` closes it. Any other value.
    Manual,
}

/// The state a `popover` value stands for. `None` is no popover: no value, `false`, or `null`.
fn kind_of_value(value: &serde_json::Value) -> Option<Kind> {
    match value {
        serde_json::Value::Bool(true) => Some(Kind::Auto),
        serde_json::Value::String(text) => Some(match text.to_ascii_lowercase().as_str() {
            "" | "auto" | "hint" => Kind::Auto,
            _ => Kind::Manual,
        }),
        serde_json::Value::Number(_) => Some(Kind::Manual),
        _ => None,
    }
}

/// What kind of popover `element` is, if it is one. A custom element has its props to itself, so
/// only the elements built as a `div` are. The element keeps the answer (`RetainedElement::popover_kind`).
pub(crate) fn kind(element: &RetainedElement) -> Option<Kind> {
    element.popover_kind()
}

/// [`kind`] worked out from the props, for the element to keep.
pub(crate) fn kind_of(element: &RetainedElement) -> Option<Kind> {
    if !crate::text::inline::is_host_container(element) {
        return None;
    }
    kind_of_value(element.custom_props().get(ATTRIBUTE_PROP)?)
}

/// The show order of `element` while it is an open popover.
pub(crate) fn shown_order(element: &RetainedElement) -> Option<u64> {
    kind(element)?;
    element.custom_props().get(OPEN_PROP)?.as_u64().filter(|order| *order > 0)
}

pub(crate) fn is_open(element: &RetainedElement) -> bool {
    shown_order(element).is_some()
}

/// Whether a write of the custom prop `key` changes the popover layer of its element.
pub(crate) fn is_popover_prop(key: &str) -> bool {
    key == ATTRIBUTE_PROP || key == OPEN_PROP
}

/// The priority of the deferred draw of an open popover. A later show is above an earlier one, and
/// both are above every `anchored` layer.
pub(crate) fn top_layer_priority(element: &RetainedElement) -> Option<usize> {
    shown_order(element).map(|order| TOP_LAYER_PRIORITY.saturating_add(order as usize))
}

/// `built` as the top layer draws it: outside the clip and the stacking of its ancestors, above the
/// rest of the window, and hit there. It lays out as `position: fixed`, which does not take part in
/// the layout of its parent.
pub(crate) fn into_top_layer(built: gpui::AnyElement, priority: usize) -> gpui::AnyElement {
    use gpui::IntoElement;

    gpui::deferred(built).in_window_space().with_priority(priority).into_any_element()
}

fn layer_styles() -> &'static (Arc<StyleDesc>, Arc<StyleDesc>) {
    static STYLES: OnceLock<(Arc<StyleDesc>, Arc<StyleDesc>)> = OnceLock::new();
    STYLES.get_or_init(|| {
        let parse = |json: &str| {
            Arc::new(
                crate::retained_tree::parse_style(json.as_bytes())
                    .unwrap_or_else(|error| panic!("the user agent style of [popover] is invalid: {error}")),
            )
        };
        (parse(OPEN_STYLE), parse(CLOSED_STYLE))
    })
}

type Combined = FxHashMap<(usize, bool), (Arc<StyleDesc>, Arc<StyleDesc>)>;

/// The user agent style of `element`: the style of its tag, if it has one, with the `[popover]`
/// rules over it. `None` when it is not a popover, and then the tag's style stands alone. Every call
/// for the same tag and state returns the one allocation, which the layer cache keys by.
pub(crate) fn user_agent(element: &RetainedElement, tag: Option<&Arc<StyleDesc>>) -> Option<Arc<StyleDesc>> {
    kind(element)?;
    let open = is_open(element);
    let (open_style, closed_style) = layer_styles();
    let layer = if open { open_style } else { closed_style };
    let Some(tag) = tag else {
        return Some(layer.clone());
    };
    static COMBINED: OnceLock<Mutex<Combined>> = OnceLock::new();
    let mut combined = COMBINED.get_or_init(Default::default).lock().expect("the popover style cache is never poisoned");
    let (_, style) = combined.entry((Arc::as_ptr(tag) as usize, open)).or_insert_with(|| {
        // The tag is kept with its entry: its address is the key.
        (tag.clone(), Arc::new(crate::universal_style::layer_under(tag, layer)))
    });
    Some(style.clone())
}

/// The style an open popover is laid out with, given the one its layers add up to: the top layer is
/// `position: fixed` against the window whatever the author declared, as Chrome computes `static` and
/// `relative` there to `absolute`, whose containing block is the window too.
pub(crate) fn used_style(element: &RetainedElement, style: Option<Arc<StyleDesc>>) -> Option<Arc<StyleDesc>> {
    if !is_open(element) || style.as_deref().is_some_and(|style| style.position.as_deref() == Some("fixed")) {
        return style;
    }
    let mut used = style.map(|style| (*style).clone()).unwrap_or_default();
    used.position = Some("fixed".to_string());
    Some(Arc::new(used))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retained_tree::RetainedTree;
    use serde_json::json;

    fn tree_with(popover: Option<serde_json::Value>) -> RetainedTree {
        let mut tree = RetainedTree::new();
        tree.create_element(1, "div".to_string());
        if let Some(value) = popover {
            tree.set_custom_prop(1, ATTRIBUTE_PROP.to_string(), value);
        }
        tree
    }

    fn style_of(tree: &RetainedTree) -> Option<Arc<StyleDesc>> {
        tree.elements[&1].style.clone()
    }

    #[test]
    fn the_values_of_the_attribute_are_the_states_of_the_spec() {
        for (value, expected) in [
            (json!(""), Some(Kind::Auto)),
            (json!("auto"), Some(Kind::Auto)),
            (json!("AUTO"), Some(Kind::Auto)),
            (json!("hint"), Some(Kind::Auto)),
            (json!(true), Some(Kind::Auto)),
            (json!("manual"), Some(Kind::Manual)),
            (json!("nonsense"), Some(Kind::Manual)),
            (json!(false), None),
            (serde_json::Value::Null, None),
        ] {
            assert_eq!(kind_of_value(&value), expected, "{value}");
        }
    }

    #[test]
    fn an_element_without_the_attribute_is_no_popover() {
        let mut tree = tree_with(None);
        assert_eq!(kind(&tree.elements[&1]), None);
        tree.set_custom_prop(1, OPEN_PROP.to_string(), json!(1));
        assert!(!is_open(&tree.elements[&1]), "the show order alone opens nothing");
        assert_eq!(style_of(&tree), None);
    }

    #[test]
    fn a_closed_popover_has_no_box() {
        let tree = tree_with(Some(json!("manual")));
        assert_eq!(style_of(&tree).unwrap().display.as_deref(), Some("none"));
    }

    #[test]
    fn an_open_popover_is_a_fixed_box_centred_in_the_window() {
        let mut tree = tree_with(Some(json!("manual")));
        tree.set_custom_prop(1, OPEN_PROP.to_string(), json!(1));
        let style = style_of(&tree).unwrap();
        assert_eq!(style.display, None);
        assert_eq!(style.position.as_deref(), Some("fixed"));
        assert!(style.top.is_some() && style.left.is_some() && style.margin.is_some());
        assert_eq!(style.width.is_some(), true);
        assert_eq!(style.overflow.as_deref(), Some("auto"));
        assert!(style.background_color.is_some() && style.color.is_some());
    }

    #[test]
    fn closing_a_popover_takes_the_open_style_away() {
        let mut tree = tree_with(Some(json!("auto")));
        tree.set_custom_prop(1, OPEN_PROP.to_string(), json!(3));
        tree.set_custom_prop(1, OPEN_PROP.to_string(), serde_json::Value::Null);
        assert_eq!(style_of(&tree).unwrap().display.as_deref(), Some("none"));
        tree.set_custom_prop(1, ATTRIBUTE_PROP.to_string(), json!(false));
        assert_eq!(style_of(&tree), None);
    }

    #[test]
    fn the_attribute_set_changed_or_removed_after_creation_moves_the_kept_kind_and_the_styles() {
        let mut tree = tree_with(None);
        assert_eq!(kind(&tree.elements[&1]), None);

        tree.set_custom_prop(1, ATTRIBUTE_PROP.to_string(), json!("auto"));
        assert_eq!(kind(&tree.elements[&1]), Some(Kind::Auto));
        assert_eq!(style_of(&tree).unwrap().display.as_deref(), Some("none"), "the user agent style follows");

        tree.set_custom_prop(1, ATTRIBUTE_PROP.to_string(), json!("manual"));
        assert_eq!(kind(&tree.elements[&1]), Some(Kind::Manual));
        tree.set_custom_prop(1, OPEN_PROP.to_string(), json!(1));
        assert_eq!(style_of(&tree).unwrap().position.as_deref(), Some("fixed"), "the used style follows");

        tree.set_custom_prop(1, ATTRIBUTE_PROP.to_string(), json!(false));
        assert_eq!(kind(&tree.elements[&1]), None);
        assert_eq!(style_of(&tree), None, "false is no popover, open or not");

        tree.set_custom_prop(1, ATTRIBUTE_PROP.to_string(), json!(""));
        assert_eq!(kind(&tree.elements[&1]), Some(Kind::Auto));
        tree.set_custom_prop(1, ATTRIBUTE_PROP.to_string(), serde_json::Value::Null);
        assert_eq!(kind(&tree.elements[&1]), None);
        assert_eq!(style_of(&tree), None);
    }

    #[test]
    fn the_hidden_attribute_set_changed_or_removed_after_creation_moves_the_style() {
        let mut tree = tree_with(None);
        let display = |tree: &RetainedTree| style_of(tree).and_then(|style| style.display.clone());
        tree.set_custom_prop(1, "hidden".to_string(), json!(true));
        assert_eq!(display(&tree).as_deref(), Some("none"));
        tree.set_custom_prop(1, "hidden".to_string(), json!("until-found"));
        assert_ne!(display(&tree).as_deref(), Some("none"), "until-found keeps its box");
        tree.set_custom_prop(1, "hidden".to_string(), json!(""));
        assert_eq!(display(&tree).as_deref(), Some("none"));
        tree.set_custom_prop(1, "hidden".to_string(), serde_json::Value::Null);
        assert_ne!(display(&tree).as_deref(), Some("none"));
    }

    #[test]
    fn an_author_style_overrides_the_user_agent_style() {
        let mut tree = tree_with(Some(json!("manual")));
        tree.set_custom_prop(1, OPEN_PROP.to_string(), json!(1));
        tree.set_style_arc(
            1,
            Arc::new(StyleDesc { position: Some("absolute".to_string()), margin_top: None, overflow: Some("hidden".to_string()), ..Default::default() }),
        );
        let style = style_of(&tree).unwrap();
        // The top layer is fixed against the window whatever position is declared, and the rest of
        // the user agent style is still under the author's.
        assert_eq!(style.position.as_deref(), Some("fixed"));
        assert_eq!(style.overflow.as_deref(), Some("hidden"));
        assert!(style.margin.is_some());
        assert!(style.background_color.is_some());
    }

    #[test]
    fn a_closed_popover_shows_when_the_author_says_display() {
        let mut tree = tree_with(Some(json!("manual")));
        tree.set_style_arc(1, Arc::new(StyleDesc { display: Some("block".to_string()), ..Default::default() }));
        assert_eq!(style_of(&tree).unwrap().display.as_deref(), Some("block"));
    }

    #[test]
    fn a_closed_popover_that_an_author_shows_keeps_the_user_agent_box() {
        let mut tree = tree_with(Some(json!("manual")));
        tree.set_style_arc(1, Arc::new(StyleDesc { display: Some("block".to_string()), ..Default::default() }));
        let style = style_of(&tree).unwrap();
        assert_eq!(style.display.as_deref(), Some("block"));
        assert_eq!(style.position.as_deref(), Some("fixed"));
        assert!(style.top.is_some() && style.left.is_some() && style.margin.is_some());
        assert!(style.border_width.is_some() || style.border_top_width.is_some());
        assert!(style.padding.is_some() || style.padding_top.is_some());
        assert_eq!(style.overflow.as_deref(), Some("auto"));
        assert!(style.background_color.is_some() && style.color.is_some());
    }

    #[test]
    fn the_style_of_a_tag_is_under_the_popover_style() {
        let mut tree = RetainedTree::new();
        tree.create_element(1, "p".to_string());
        tree.set_custom_prop(1, ATTRIBUTE_PROP.to_string(), json!("manual"));
        tree.set_custom_prop(1, OPEN_PROP.to_string(), json!(1));
        let style = tree.elements[&1].style.clone().unwrap();
        assert_eq!(style.display.as_deref(), Some("block"), "from <p>");
        assert_eq!(style.position.as_deref(), Some("fixed"));
        assert!(style.margin.is_some(), "the popover margin: auto replaces the paragraph margin");
        assert_eq!(style.margin_top, None);
        tree.create_element(2, "p".to_string());
        tree.set_custom_prop(2, ATTRIBUTE_PROP.to_string(), json!("manual"));
        tree.set_custom_prop(2, OPEN_PROP.to_string(), json!(2));
        assert!(Arc::ptr_eq(tree.elements[&2].style.as_ref().unwrap(), tree.elements[&1].style.as_ref().unwrap()));
    }

    #[test]
    fn a_custom_element_is_no_popover() {
        let mut tree = RetainedTree::new();
        tree.create_element(1, "anchored".to_string());
        tree.set_custom_prop(1, ATTRIBUTE_PROP.to_string(), json!("manual"));
        assert_eq!(kind(&tree.elements[&1]), None);
        assert_eq!(tree.elements[&1].style, None);
    }

    #[test]
    fn a_later_show_is_on_top_of_an_earlier_one_and_of_every_anchored_layer() {
        let mut tree = RetainedTree::new();
        for id in [1, 2] {
            tree.create_element(id, "div".to_string());
            tree.set_custom_prop(id, ATTRIBUTE_PROP.to_string(), json!("manual"));
        }
        assert_eq!(top_layer_priority(&tree.elements[&1]), None);
        tree.set_custom_prop(2, OPEN_PROP.to_string(), json!(1));
        tree.set_custom_prop(1, OPEN_PROP.to_string(), json!(2));
        assert!(top_layer_priority(&tree.elements[&1]) > top_layer_priority(&tree.elements[&2]));
        assert!(top_layer_priority(&tree.elements[&2]).unwrap() > 1_000);
    }
}
