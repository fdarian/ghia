//! A style value that does not parse drops that declaration and nothing else, as in CSS.
//!
//! `StyleTable::intern` parses a payload strictly, and that stays the whole cost of a style that
//! is valid. Only when it fails does [`recover`] run: it reads the object as its declarations in
//! written order (`css::covers` drops the longhands written before a shorthand, so the order is
//! part of the meaning), judges each declaration alone with the same check `intern` runs, and
//! parses the declarations that passed. Web code hands over values a CSS engine would ignore
//! (`border: 0` as a number, `height: "inherit"`, `width: "wide"`), and one of them
//! must not take down the app.
//!
//! A declaration that fails alone is:
//! - a number: tried again as React DOM writes it, `0` as `"0"`, a unitless property
//!   (`opacity`, `zIndex`, ...) as the bare number, anything else as `<n>px`;
//! - an object (a state style such as `hover`, or an `@container` block): recovered the same way
//!   inside, and dropped whole only if what is left still fails;
//! - anything else, the CSS-wide keywords (`inherit`, `initial`, `unset`, `revert`,
//!   `revert-layer`) among them: dropped, and logged once.
//!
//! Dropping is CSS's answer for `unset` and `revert` and for `initial` on a property that is not
//! inherited. `initial` on an inherited property, and `inherit`, would need a value from the
//! parent; see `docs/fork/deviations.md`.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex, PoisonError};

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::value::RawValue;

use crate::retained_tree::parse_style;
use crate::style::StyleDesc;

/// Properties React DOM sends a number for without adding `px`.
const UNITLESS: &[&str] = &[
    "animationIterationCount", "aspectRatio", "borderImageOutset", "borderImageSlice", "borderImageWidth",
    "columnCount", "columns", "flex", "flexGrow", "flexShrink", "fontWeight", "gridArea", "gridColumn",
    "gridColumnEnd", "gridColumnStart", "gridRow", "gridRowEnd", "gridRowStart", "lineClamp", "lineHeight",
    "opacity", "order", "orphans", "scale", "tabSize", "widows", "zIndex", "zoom",
    "fillOpacity", "floodOpacity", "stopOpacity", "strokeDasharray", "strokeDashoffset", "strokeMiterlimit",
    "strokeOpacity", "strokeWidth",
];

/// How many dropped declarations are remembered before the set starts over.
const REPORTED_LIMIT: usize = 1024;

static REPORTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

pub(crate) struct Declaration {
    pub(crate) key: String,
    /// The JSON text of the value.
    pub(crate) value: String,
}

/// The declarations of a style object in written order.
pub(crate) struct Declarations(pub(crate) Vec<Declaration>);

impl<'de> Deserialize<'de> for Declarations {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(DeclarationsVisitor)
    }
}

struct DeclarationsVisitor;

impl<'de> Visitor<'de> for DeclarationsVisitor {
    type Value = Declarations;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a style object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut declarations = Vec::new();
        while let Some(key) = map.next_key::<String>()? {
            let value: Box<RawValue> = map.next_value()?;
            declarations.push(Declaration { key, value: value.get().to_owned() });
        }
        Ok(Declarations(declarations))
    }
}

/// Parse `raw`, which `parse_style` rejected with `error`, without the declarations that fail.
/// `error` is returned when `raw` is not an object, or when every declaration passes alone and the
/// object still fails, which is not a value problem.
pub(crate) fn recover(raw: &[u8], error: String) -> Result<StyleDesc, String> {
    let Ok(declarations) = serde_json::from_slice::<Declarations>(raw) else {
        return Err(error);
    };
    let mut recovery = Recovery { path: Vec::new(), changed: false };
    let kept = recovery.keep(declarations.0);
    if !recovery.changed {
        return Err(error);
    }
    parse_style(object_text(&kept).as_bytes())
}

struct Recovery {
    /// The keys of the objects around the declaration being judged.
    path: Vec<String>,
    changed: bool,
}

impl Recovery {
    fn keep(&mut self, declarations: Vec<Declaration>) -> Vec<Declaration> {
        let mut kept = Vec::with_capacity(declarations.len());
        for declaration in declarations {
            if self.accepts(&declaration.key, &declaration.value) {
                kept.push(declaration);
                continue;
            }
            self.changed = true;
            let replacement = match object_declarations(&declaration.value) {
                Some(nested) => {
                    self.path.push(declaration.key.clone());
                    let inner = self.keep(nested);
                    self.path.pop();
                    Some(object_text(&inner))
                }
                None => number_as_text(&declaration.key, &declaration.value),
            };
            match replacement {
                Some(value) if self.accepts(&declaration.key, &value) => {
                    kept.push(Declaration { key: declaration.key, value });
                }
                _ => self.drop_declaration(&declaration),
            }
        }
        kept
    }

    fn accepts(&self, key: &str, value: &str) -> bool {
        parse_style(self.alone(key, value).as_bytes()).is_ok()
    }

    /// `{key: value}`, wrapped in the objects the declaration sits in.
    fn alone(&self, key: &str, value: &str) -> String {
        let mut text = String::new();
        for outer in &self.path {
            text.push('{');
            text.push_str(&json_string(outer));
            text.push(':');
        }
        text.push('{');
        text.push_str(&json_string(key));
        text.push(':');
        text.push_str(value);
        text.push('}');
        for _ in &self.path {
            text.push('}');
        }
        text
    }

    fn drop_declaration(&self, declaration: &Declaration) {
        let mut name = self.path.join(".");
        if !name.is_empty() {
            name.push('.');
        }
        name.push_str(&declaration.key);
        if first_report(&name, &declaration.value) {
            log::warn!("Dropped style declaration {name}: {}", declaration.value);
        }
    }
}

pub(crate) fn json_string(text: &str) -> String {
    serde_json::to_string(text).expect("a string serializes")
}

pub(crate) fn object_text(declarations: &[Declaration]) -> String {
    let members: Vec<String> = declarations
        .iter()
        .map(|declaration| format!("{}:{}", json_string(&declaration.key), declaration.value))
        .collect();
    format!("{{{}}}", members.join(","))
}

fn object_declarations(value: &str) -> Option<Vec<Declaration>> {
    if !value.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Declarations>(value).ok().map(|declarations| declarations.0)
}

/// Whether the value of `key` is a `<number>`, which React DOM writes without a unit.
pub(crate) fn is_unitless(key: &str) -> bool {
    UNITLESS.contains(&key)
}

/// The text React DOM would write for a number `value` of `key`, or `None` when `value` is not a
/// number.
pub(crate) fn number_text(key: &str, value: &str) -> Option<String> {
    let number: serde_json::Number = serde_json::from_str(value).ok()?;
    Some(if number.as_f64() == Some(0.0) {
        "0".to_owned()
    } else if is_unitless(key) {
        number.to_string()
    } else {
        format!("{number}px")
    })
}

fn number_as_text(key: &str, value: &str) -> Option<String> {
    number_text(key, value).map(|text| json_string(&text))
}

/// Whether this is the first time `name: value` is dropped, so a re-render does not log it again.
fn first_report(name: &str, value: &str) -> bool {
    let mut reported = REPORTED.lock().unwrap_or_else(PoisonError::into_inner);
    if reported.len() >= REPORTED_LIMIT {
        reported.clear();
    }
    reported.insert(format!("{name}: {value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recovered(json: &str) -> StyleDesc {
        let error = parse_style(json.as_bytes()).expect_err("the strict parse rejects it");
        recover(json.as_bytes(), error).expect("the rest of the style parses")
    }

    #[test]
    fn a_number_is_written_as_react_dom_writes_it() {
        assert_eq!(number_as_text("border", "0"), Some(r#""0""#.to_owned()));
        assert_eq!(number_as_text("border", "-0.0"), Some(r#""0""#.to_owned()));
        assert_eq!(number_as_text("border", "2"), Some(r#""2px""#.to_owned()));
        assert_eq!(number_as_text("border", "1.5"), Some(r#""1.5px""#.to_owned()));
        assert_eq!(number_as_text("zIndex", "3"), Some(r#""3""#.to_owned()));
        assert_eq!(number_as_text("opacity", "0.5"), Some(r#""0.5""#.to_owned()));
        assert_eq!(number_as_text("border", r#""2""#), None);
    }

    #[test]
    fn border_zero_keeps_its_declaration() {
        let style = recovered(r#"{"border": 0, "backgroundColor": "red"}"#);
        assert_eq!(style.border.as_deref(), Some("0"));
        assert_eq!(style.background_color.as_deref(), Some("red"));
    }

    #[test]
    fn a_number_that_is_still_invalid_is_dropped() {
        let style = recovered(r#"{"border": 2, "display": "flex", "transitionDuration": 5}"#);
        assert_eq!(style.border.as_deref(), Some("2px"));
        assert_eq!(style.display.as_deref(), Some("flex"));
        assert_eq!(style.transition_duration, None);
    }

    #[test]
    fn css_wide_keywords_are_dropped() {
        for keyword in ["inherit", "initial", "unset", "revert", "revert-layer"] {
            let style = recovered(&format!(r#"{{"height": "{keyword}", "backgroundColor": "red"}}"#));
            assert_eq!(style.height, None, "{keyword}");
            assert_eq!(style.background_color.as_deref(), Some("red"), "{keyword}");
        }
    }

    #[test]
    fn a_var_dimension_is_dropped_and_its_siblings_stay() {
        let style = recovered(r#"{"width": "var(--anchor-width)", "height": 10, "opacity": 0.5}"#);
        assert_eq!(style.width, None);
        assert!(style.height.is_some());
        assert_eq!(style.opacity, Some(0.5));
    }

    #[test]
    fn written_order_survives_a_shorthand_after_longhands() {
        let before = recovered(r#"{"paddingTop": 4, "width": "var(--x)", "padding": 8}"#);
        assert_eq!(before.padding_top, None);
        assert!(before.padding.is_some());

        let after = recovered(r#"{"padding": 8, "width": "var(--x)", "paddingTop": 4}"#);
        assert!(after.padding_top.is_some());
    }

    #[test]
    fn the_declarations_of_a_state_style_recover_inside_it() {
        let style = recovered(r#"{"backgroundColor": "red", "hover": {"width": "inherit", "opacity": 0.5}}"#);
        assert_eq!(style.background_color.as_deref(), Some("red"));
        let hover = style.hover.expect("the state style stays");
        assert_eq!(hover.width, None);
        assert_eq!(hover.opacity, Some(0.5));
    }

    #[test]
    fn motion_declarations_are_judged_with_the_rest() {
        let style = recovered(
            r#"{"transitionProperty": "opacity", "transitionDuration": "200ms", "height": "inherit",
                "animationName": "x", "animationDuration": "1s"}"#,
        );
        assert_eq!(style.height, None);
        assert_eq!(style.transition_duration.as_deref(), Some("200ms"));
    }

    #[test]
    fn a_style_that_is_not_an_object_still_errors() {
        for json in ["5", "[1]", "null", r#"{"width": "#] {
            let error = parse_style(json.as_bytes()).err().unwrap_or_else(|| "accepted".to_owned());
            assert_eq!(recover(json.as_bytes(), error.clone()).err(), Some(error), "{json}");
        }
    }

    #[test]
    fn a_dropped_declaration_is_reported_once() {
        assert!(first_report("lenient-test.width", r#""var(--once)""#));
        assert!(!first_report("lenient-test.width", r#""var(--once)""#));
        assert!(first_report("lenient-test.width", r#""var(--other)""#));
    }
}
