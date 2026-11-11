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

/// Whether the tag is inline unless a style says otherwise, as a `span` is.
pub fn is_inline_tag(element_type: &str) -> bool {
    styles().get(element_type).is_some_and(|style| style.display.as_deref() == Some("inline"))
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
    fn a_tag_is_inline_by_its_display() {
        for tag in ["a", "strong", "em", "br", "sub", "kbd"] {
            assert!(is_inline_tag(tag), "<{tag}>");
        }
        for tag in ["p", "h1", "li", "button", "td", "dialog", "span", "div"] {
            assert!(!is_inline_tag(tag), "<{tag}>");
        }
    }

    #[test]
    fn the_values_of_a_heading_resolve_against_its_own_size() {
        let h1 = ua_style("h1").unwrap();
        assert_eq!(h1.font_weight, Some(crate::style::FontWeightValue::Num(700.0)));
        assert!(h1.margin_top.is_some() && h1.font_size.is_some());
    }
}
