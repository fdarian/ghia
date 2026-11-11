//! A property whose CSS value can also be one keyword that means "not set": `z-index: auto`,
//! `line-clamp: none`, `max-width: none` and `gap: normal`. The keyword is no value, so it reads as
//! `None`, as an absent key does.

use serde::{Deserialize, Deserializer};

use crate::css::dimension::parse_linear_length;
use crate::css::shorthand::{self, deserialize_optional, length_token, Gap};
use crate::css::length::LinearLength;
use crate::style::DimensionValue;

fn deserialize_number_or<'de, D: Deserializer<'de>>(
    deserializer: D,
    property: &'static str,
    keyword: &'static str,
) -> Result<Option<f64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Value {
        Number(f64),
        Text(String),
    }
    match Option::<Value>::deserialize(deserializer)? {
        None => Ok(None),
        Some(Value::Number(number)) => Ok(Some(number)),
        Some(Value::Text(text)) if text.trim().eq_ignore_ascii_case(keyword) => Ok(None),
        Some(Value::Text(text)) => Err(serde::de::Error::custom(format!(
            "{property}: expected a number or `{keyword}`, found `{}`",
            text.trim()
        ))),
    }
}

pub(crate) fn deserialize_z_index<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    deserialize_number_or(deserializer, "zIndex", "auto")
}

pub(crate) fn deserialize_line_clamp<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    deserialize_number_or(deserializer, "lineClamp", "none")
}

/// `text` read by `parse`, unless it is `keyword`, which is no value.
fn unless_keyword<T>(
    text: &str,
    keyword: &str,
    parse: impl FnOnce(&str) -> Result<T, String>,
) -> Result<Option<T>, String> {
    if text.trim().eq_ignore_ascii_case(keyword) {
        Ok(None)
    } else {
        parse(text).map(Some)
    }
}

/// `maxWidth` and `maxHeight`: a dimension, or `none`.
pub(crate) fn deserialize_max_size<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<DimensionValue>, D::Error> {
    deserialize_optional(
        deserializer,
        "a number of px, a CSS length string, or 'none'",
        |value| Ok(Some(DimensionValue::Pixels(value))),
        |text| unless_keyword(text, "none", DimensionValue::parse),
    )
    .map(Option::flatten)
}

/// `rowGap` and `columnGap`: a length, or `normal`.
pub(crate) fn deserialize_gap_length<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<LinearLength>, D::Error> {
    let token = length_token("length", "a CSS length with a unit, or calc()", parse_linear_length);
    deserialize_optional(
        deserializer,
        "a number of px, a CSS length string, or 'normal'",
        |value| shorthand::px_length(value, "length").map(Some),
        |text| unless_keyword(text, "normal", &token),
    )
    .map(Option::flatten)
}

/// `gap`: one or two lengths, or `normal`.
pub(crate) fn deserialize_gap<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Gap>, D::Error> {
    let token = length_token("gap", "a CSS length with a unit, or calc()", parse_linear_length);
    deserialize_optional(
        deserializer,
        "a number of px or a string of one or two CSS lengths, or 'normal'",
        |value| shorthand::px_length(value, "gap").map(|length| Some(Gap::all(length))),
        |text| unless_keyword(text, "normal", |text| shorthand::parse_gap(text, &token)),
    )
    .map(Option::flatten)
}

#[cfg(test)]
mod tests {
    use crate::style::StyleDesc;

    fn parse(json: &str) -> Result<StyleDesc, serde_json::Error> {
        serde_json::from_str::<StyleDesc>(json)
    }

    #[test]
    fn z_index_and_line_clamp_read_a_number() {
        let style = parse(r#"{"zIndex":3,"lineClamp":2}"#).unwrap();
        assert_eq!((style.z_index, style.line_clamp), (Some(3.0), Some(2.0)));
    }

    #[test]
    fn auto_and_none_are_no_value_and_do_not_fail_the_strict_parse() {
        let style = parse(r#"{"zIndex":"auto","lineClamp":" None "}"#).unwrap();
        assert_eq!((style.z_index, style.line_clamp), (None, None));
    }

    #[test]
    fn another_text_is_still_an_error() {
        assert!(parse(r#"{"zIndex":"none"}"#).is_err());
        assert!(parse(r#"{"lineClamp":"auto"}"#).is_err());
        assert!(parse(r#"{"zIndex":"high"}"#).is_err());
    }

    #[test]
    fn none_and_normal_are_no_value_for_max_sizes_and_gaps() {
        let style = parse(r#"{"maxWidth":"none","maxHeight":" None ","gap":"normal","rowGap":"Normal","columnGap":"normal"}"#).unwrap();
        assert_eq!(
            (style.max_width, style.max_height, style.gap, style.row_gap, style.column_gap),
            (None, None, None, None, None)
        );
    }

    #[test]
    fn max_sizes_and_gaps_still_read_lengths_and_reject_other_text() {
        let style = parse(r#"{"maxWidth":"50%","maxHeight":20,"gap":"4px 8px","rowGap":3,"columnGap":"2em"}"#).unwrap();
        assert!(style.max_width.is_some() && style.max_height.is_some() && style.gap.is_some());
        assert!(style.row_gap.is_some() && style.column_gap.is_some());
        assert!(parse(r#"{"maxWidth":"normal"}"#).is_err());
        assert!(parse(r#"{"gap":"none"}"#).is_err());
        assert!(parse(r#"{"rowGap":"none"}"#).is_err());
        assert!(parse(r#"{"columnGap":"auto"}"#).is_err());
        assert!(parse(r#"{"gap":"4px normal"}"#).is_err());
    }
}
