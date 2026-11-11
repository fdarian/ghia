//! A number property whose CSS value can also be one keyword that means "not set": `z-index: auto`
//! and `line-clamp: none`. The keyword is no value, so it reads as `None`, as an absent key does.

use serde::{Deserialize, Deserializer};

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
}
