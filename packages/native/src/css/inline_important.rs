//! `!important` at the end of an inline value, as React DOM writes `display: none !important`
//! to hide a Suspense child.
//!
//! The suffix is not part of a value: it is stripped before a payload is parsed, so a style with
//! no sheet reads it as the plain value. `StyleTable` keeps the payload as it came, and the
//! cascade of an element that sheets matched reads the declarations that had the suffix from it:
//! they apply after the `!important` declarations of the sheets, as an inline `!important` beats an
//! author one.

use std::borrow::Cow;

use crate::css::lenient::{json_string, object_text, Declaration, Declarations};

/// Whether a payload may hold one: a search of the bytes, which a payload that has none pays for
/// and nothing else.
pub(crate) fn mentions(raw: &[u8]) -> bool {
    raw.windows(9).any(|window| window.eq_ignore_ascii_case(b"important"))
}

/// The JSON text of the value without its `!important`, or `None` for a value that has none.
pub(crate) fn strip_value(value: &str) -> Option<String> {
    if !value.starts_with('"') {
        return None;
    }
    let text = serde_json::from_str::<String>(value).ok()?;
    let text = text.trim_end();
    let keyword = text.len().checked_sub("important".len())?;
    if !text.is_char_boundary(keyword) || !text[keyword..].eq_ignore_ascii_case("important") {
        return None;
    }
    let bang = text[..keyword].trim_end().strip_suffix('!')?;
    Some(json_string(bang.trim_end()))
}

/// `raw` with the suffix taken off every top-level declaration that has it.
pub(crate) fn strip_payload(raw: &[u8]) -> Cow<'_, [u8]> {
    if !mentions(raw) {
        return Cow::Borrowed(raw);
    }
    let Ok(declarations) = serde_json::from_slice::<Declarations>(raw) else {
        return Cow::Borrowed(raw);
    };
    let mut changed = false;
    let stripped: Vec<Declaration> = declarations
        .0
        .into_iter()
        .map(|declaration| match strip_value(&declaration.value) {
            Some(value) => {
                changed = true;
                Declaration { key: declaration.key, value }
            }
            None => declaration,
        })
        .collect();
    if !changed {
        return Cow::Borrowed(raw);
    }
    Cow::Owned(object_text(&stripped).into_bytes())
}

/// The declarations without the suffix, and the ones that had it (with the suffix taken off), each
/// in written order.
pub(crate) fn split(declarations: Vec<Declaration>) -> (Vec<Declaration>, Vec<Declaration>) {
    let mut normal = Vec::with_capacity(declarations.len());
    let mut important = Vec::new();
    for declaration in declarations {
        match strip_value(&declaration.value) {
            Some(value) => important.push(Declaration { key: declaration.key, value }),
            None => normal.push(declaration),
        }
    }
    (normal, important)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_suffix_is_taken_off_a_string_value() {
        assert_eq!(strip_value(r#""none !important""#).as_deref(), Some(r#""none""#));
        assert_eq!(strip_value(r#""none! IMPORTANT ""#).as_deref(), Some(r#""none""#));
        assert_eq!(strip_value(r#""none""#), None);
        assert_eq!(strip_value(r#""important""#), None);
        assert_eq!(strip_value("5"), None);
    }

    #[test]
    fn a_payload_without_the_suffix_is_not_copied() {
        assert!(matches!(strip_payload(br#"{"display":"none"}"#), Cow::Borrowed(_)));
        assert!(matches!(strip_payload(br#"{"--important":"x"}"#), Cow::Borrowed(_)));
        let stripped = strip_payload(br#"{"color":"red","display":"none !important"}"#);
        assert_eq!(&*stripped, br#"{"color":"red","display":"none"}"#);
    }
}
