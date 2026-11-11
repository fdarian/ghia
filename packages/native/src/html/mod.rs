//! HTML tags: `<p>`, `<h1>`, `<strong>`, `<ul>`, `<table>` and the rest of [`tags::TAGS`] are
//! host elements that lay out as a `div` or a `span` does, with the style Chrome's user agent
//! stylesheet gives the tag. The style is the lowest layer under an element: below the universal
//! style, which is below the element's own (`RetainedTree::refresh_effective_style`).

mod semantics;
mod tags;

pub(crate) use semantics::{
    activation_keys, activation_target, button_type, heading_level, implicit_role, is_activatable, is_focusable_by_default, ActivationKeys,
    ButtonType,
};

use std::sync::{Arc, OnceLock};

use rustc_hash::FxHashMap;

use crate::style::StyleDesc;

fn styles() -> &'static FxHashMap<&'static str, Arc<StyleDesc>> {
    static STYLES: OnceLock<FxHashMap<&'static str, Arc<StyleDesc>>> = OnceLock::new();
    STYLES.get_or_init(|| {
        tags::TAGS
            .iter()
            .map(|(tag, json)| {
                let style = crate::retained_tree::parse_style(json.as_bytes())
                    .unwrap_or_else(|error| panic!("the user agent style of <{tag}> is invalid: {error}"));
                (*tag, Arc::new(style))
            })
            .collect()
    })
}

/// What `<wbr>` puts in the text of its paragraph: a zero width space, where a line may break. It is
/// not read out.
pub const BREAK_OPPORTUNITY: char = '\u{200B}';

/// Whether `element_type` is an HTML tag with a user agent style.
pub fn is_tag(element_type: &str) -> bool {
    styles().contains_key(element_type)
}

/// The user agent style of `element_type`. Every call returns the one allocation of a tag, and no
/// two tags share one: a cache keyed by it cannot mix them up.
pub fn ua_style(element_type: &str) -> Option<Arc<StyleDesc>> {
    styles().get(element_type).cloned()
}

/// The user agent style of `element`: its tag's, and for an `<input>` its `type`'s, since Chrome's `html.css`
/// has a rule for each (a checkbox and a radio are small `inline-block` boxes with a margin, a hidden input
/// is not displayed). A text field has none.
pub fn ua_style_of(element: &crate::retained_tree::RetainedElement) -> Option<Arc<StyleDesc>> {
    if element.element_type != "input" {
        return ua_style(&element.element_type);
    }
    let name = match crate::custom_elements::input_choice::input_type(element.custom_props()) {
        crate::custom_elements::input_rules::InputType::Checkbox => "input[type=checkbox]",
        crate::custom_elements::input_rules::InputType::Radio => "input[type=radio]",
        crate::custom_elements::input_rules::InputType::Hidden => "input[type=hidden]",
        crate::custom_elements::input_rules::InputType::Range => "input[type=range]",
        _ => return None,
    };
    styles().get(name).cloned()
}

/// The style `element_type` is laid out and read with, given the one its layers add up to. Chrome lays a
/// `<button>` out as `inline-block` whatever its `display` says: `inline` computes to `inline-block`, so the
/// button stays an atomic inline, with its box and its accessibility node, and no paragraph runs on in it.
pub(crate) fn used_style(element_type: &str, style: Option<Arc<StyleDesc>>) -> Option<Arc<StyleDesc>> {
    if element_type != "button" || style.as_deref().and_then(|style| style.display.as_deref()) != Some("inline") {
        return style;
    }
    style.map(|style| {
        let mut used = (*style).clone();
        used.display = Some("inline-block".to_string());
        Arc::new(used)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tag_has_a_style_of_its_own() {
        let mut seen = std::collections::HashSet::new();
        for (tag, _) in tags::TAGS {
            assert!(seen.insert(*tag), "<{tag}> is listed twice");
            let style = ua_style(tag).expect("a style");
            assert!(style.display.is_some(), "<{tag}> says no display");
            assert!(Arc::ptr_eq(&style, &ua_style(tag).unwrap()));
        }
        let all: Vec<_> = seen.iter().map(|tag| ua_style(tag).unwrap()).collect();
        for (index, style) in all.iter().enumerate() {
            assert!(all[..index].iter().all(|other| !Arc::ptr_eq(style, other)));
        }
    }

    #[test]
    fn the_tags_ghia_builds_itself_are_not_in_the_table() {
        for tag in ["div", "span", "label", "form", "img", "svg", "input", "textarea", "code", "select", "#text", "nativeview"] {
            assert!(!is_tag(tag), "<{tag}> has a built-in meaning");
        }
    }

    #[test]
    fn the_values_of_a_heading_resolve_against_its_own_size() {
        let h1 = ua_style("h1").unwrap();
        assert_eq!(h1.font_weight, Some(crate::style::FontWeightValue::Num(700.0)));
        assert!(h1.margin_top.is_some() && h1.font_size.is_some());
    }
}
