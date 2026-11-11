//! A CSS-wide keyword written by an author beats the layers under the author's style.
//!
//! The declared style of an element (its sheets' cascade and its inline style) is laid over the
//! universal style, which is laid over the user agent style of the tag and of a `popover`. A
//! keyword cannot be a value in that style, so it would leave the value below in place, and
//! `margin: unset` on an open `[popover]` would keep the user agent's `margin: auto`. In CSS an
//! author `initial`, `unset` and `inherit` come before the user agent origin in the cascade, and
//! `revert` is the keyword that gives it back.
//!
//! [`resolve`] runs where a style is interned, on the text of the style the cascade merged or an
//! inline style as it came, and rewrites its top-level keywords:
//! - `initial` and `unset` (and `inherit` where the property inherits) reset the properties they
//!   name: the style's [`reset`](crate::style::StyleDesc::reset) lists them and `overlay` clears
//!   them from the layers under it. A property that does not inherit is then at its initial value,
//!   which needs no value of its own, and one that inherits takes its parent's. A shorthand that a
//!   layer keeps still gives a longhand its value (`padding-left: unset` over `padding: 1px 6px`),
//!   so `overlay` writes the initial value of such a longhand (`initial.rs`);
//! - a longhand that a shorthand written earlier in the same declarations gave a value is written
//!   at its initial value, in place, after the shorthand, whichever keyword it is (`inset: 0` and
//!   then `right: unset`);
//! - `revert` and `revert-layer` take back the author's earlier declarations of the property and
//!   leave the layers under it.
//!
//! Only the style's own declarations are read: a keyword inside a state style or an `@container`
//! block is still dropped (`css::lenient`).

use std::sync::Arc;

use crate::css::covers::{self, KeyId};
use crate::css::lenient::{object_text, Declaration, Declarations};

use super::initial;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Keyword {
    Initial,
    Unset,
    Inherit,
    Revert,
    RevertLayer,
}

pub(super) fn keyword_of(value: &str) -> Option<Keyword> {
    if !value.starts_with('"') {
        return None;
    }
    let text = serde_json::from_str::<String>(value).ok()?;
    let text = text.trim();
    [
        ("initial", Keyword::Initial),
        ("unset", Keyword::Unset),
        ("inherit", Keyword::Inherit),
        ("revert", Keyword::Revert),
        ("revert-layer", Keyword::RevertLayer),
    ]
    .into_iter()
    .find(|(name, _)| text.eq_ignore_ascii_case(name))
    .map(|(_, keyword)| keyword)
}

/// Whether the JSON text of a value is a CSS-wide keyword string.
pub(super) fn is_css_wide(value: &str) -> bool {
    keyword_of(value).is_some()
}

/// The properties of `StyleDesc` that inherit, by the name a style object writes them. `inherit`
/// on one of these takes the parent's value, which is what a reset leaves.
const INHERITED: &[&str] = &[
    "visibility", "color", "colorScheme", "fontStyle", "fontSize", "fontFamily", "fontWeight",
    "fontVariantNumeric", "fontFeatureSettings", "fontVariationSettings", "webkitFontSmoothing",
    "textAlign", "direction", "lineHeight", "whiteSpace", "tabSize", "wordBreak", "overflowWrap",
    "textWrap", "textWrapMode", "textWrapStyle", "textUnderlineOffset", "borderSpacing",
    "borderCollapse", "captionSide", "emptyCells", "cursor", "pointerEvents", "userSelect",
    "scrollbarColor", "interpolateSize", "appRegion",
];

/// A style text with its keywords rewritten, and what they reset.
pub(crate) struct Resolved {
    pub(crate) text: String,
    pub(crate) reset: Option<Arc<Vec<String>>>,
}

/// A search of the bytes for a keyword, which a payload that has none pays for and nothing else.
fn mentions_keyword(raw: &[u8]) -> bool {
    let starts = |at: usize, word: &[u8]| raw.get(at..at + word.len()).is_some_and(|slice| slice.eq_ignore_ascii_case(word));
    (0..raw.len()).any(|at| match raw[at].to_ascii_lowercase() {
        b'u' => starts(at, b"unset"),
        b'i' => starts(at, b"initial") || starts(at, b"inherit"),
        b'r' => starts(at, b"revert"),
        _ => false,
    })
}

/// `raw` with the keywords of its top-level declarations resolved, or `None` when it has none.
pub(crate) fn resolve(raw: &[u8]) -> Option<Resolved> {
    if !mentions_keyword(raw) {
        return None;
    }
    let declarations = serde_json::from_slice::<Declarations>(raw).ok()?.0;
    if !declarations.iter().any(|declaration| !declaration.key.starts_with("--") && is_css_wide(&declaration.value)) {
        return None;
    }
    let mut list: Vec<Declaration> = Vec::with_capacity(declarations.len());
    let mut reset: Vec<String> = Vec::new();
    for declaration in declarations {
        list.retain(|earlier| earlier.key != declaration.key);
        match keyword_of(&declaration.value) {
            Some(keyword) if !declaration.key.starts_with("--") => apply(&mut list, &mut reset, &declaration.key, keyword),
            _ => list.push(declaration),
        }
    }
    reset.sort();
    reset.dedup();
    Some(Resolved { text: object_text(&list), reset: (!reset.is_empty()).then(|| Arc::new(reset)) })
}

fn apply(list: &mut Vec<Declaration>, reset: &mut Vec<String>, key: &str, keyword: Keyword) {
    let id = covers::key_id(key);
    let covered: &[KeyId] = id.map_or(&[], covers::covered_by);
    list.retain(|earlier| covers::key_id(&earlier.key).is_none_or(|earlier| !covered.contains(&earlier)));
    let longhands: Vec<KeyId> = match id {
        Some(id) if covered.is_empty() => vec![id],
        Some(_) => covered.iter().copied().filter(|target| covers::covered_by(*target).is_empty()).collect(),
        None => Vec::new(),
    };
    for longhand in longhands {
        // A shorthand written earlier still gives the longhand a value, and the keyword has to take
        // that back: the initial value written after it wins over it.
        if let Some(initial) = initial::of(longhand).filter(|_| is_shadowed(list, longhand)) {
            list.push(initial.clone());
        }
    }
    let named = || std::iter::once(key.to_owned()).chain(covered.iter().map(|target| covers::name_of(*target)));
    match keyword {
        Keyword::Initial | Keyword::Unset => reset.extend(named()),
        Keyword::Inherit => reset.extend(named().filter(|name| INHERITED.contains(&name.as_str()))),
        Keyword::Revert | Keyword::RevertLayer => {}
    }
}

fn is_shadowed(list: &[Declaration], longhand: KeyId) -> bool {
    list.iter()
        .any(|earlier| covers::key_id(&earlier.key).is_some_and(|shorthand| covers::covered_by(shorthand).contains(&longhand)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(json: &str) -> (serde_json::Value, Vec<String>) {
        let resolved = resolve(json.as_bytes()).expect("the style has a keyword");
        let text = serde_json::from_str(&resolved.text).expect("the text is JSON");
        (text, resolved.reset.map(|reset| reset.to_vec()).unwrap_or_default())
    }

    #[test]
    fn a_style_with_no_keyword_is_left_alone() {
        for json in [
            r#"{"color":"red","right":0}"#,
            r#"{"content":"an unset value"}"#,
            r#"{"hover":{"width":"unset"}}"#,
            r#"{"--x":"initial"}"#,
            "[1]",
            "5",
        ] {
            assert!(resolve(json.as_bytes()).is_none(), "{json}");
        }
    }

    #[test]
    fn a_keyword_is_removed_from_the_text_and_resets_what_it_names() {
        let (text, reset) = resolved(r#"{"right":"unset","left":"1px"}"#);
        assert_eq!(text, serde_json::json!({"left": "1px"}));
        assert_eq!(reset, ["right"]);
    }

    #[test]
    fn a_keyword_on_a_shorthand_resets_the_names_it_covers_and_takes_back_the_longhands_before_it() {
        let (text, reset) = resolved(r#"{"marginTop":"4px","margin":"initial"}"#);
        assert_eq!(text, serde_json::json!({}));
        for name in ["margin", "marginBlock", "marginInline", "marginTop", "marginLeft"] {
            assert!(reset.contains(&name.to_owned()), "{name}");
        }
    }

    #[test]
    fn a_property_with_no_initial_value_to_write_is_only_reset() {
        let (text, reset) = resolved(r#"{"color":"unset","width":"INITIAL"}"#);
        assert_eq!(text, serde_json::json!({}));
        assert_eq!(reset, ["color", "width"]);
    }

    #[test]
    fn inherit_resets_a_property_that_inherits_and_no_other() {
        let (_, reset) = resolved(r#"{"fontWeight":"inherit","marginTop":"inherit","width":"inherit"}"#);
        assert_eq!(reset, ["fontWeight"]);
    }

    #[test]
    fn revert_takes_back_the_authors_declarations_and_resets_nothing() {
        let (text, reset) = resolved(r#"{"color":"revert","opacity":0.5,"width":"revert-layer"}"#);
        assert_eq!(text, serde_json::json!({"opacity": 0.5}));
        assert!(reset.is_empty());
    }

    #[test]
    fn a_longhand_a_shorthand_before_the_keyword_gave_is_written_at_its_initial_value() {
        for keyword in ["revert", "unset", "inherit"] {
            let (text, _) = resolved(&format!(r#"{{"inset":0,"right":"{keyword}"}}"#));
            assert_eq!(text, serde_json::json!({"inset": 0, "right": "auto"}), "{keyword}");
        }
    }

    #[test]
    fn every_inherited_name_is_a_property_of_the_style() {
        for name in INHERITED {
            assert!(crate::events::state_styles::is_property(name), "{name}");
        }
    }
}
