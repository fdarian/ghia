//! `opacity` as CSS reads it: a number, or text of a number or a percentage.

use serde::{Deserialize, Deserializer};

pub(crate) fn deserialize_opacity<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Opacity {
        Number(f64),
        Text(String),
    }
    let Some(opacity) = Option::<Opacity>::deserialize(deserializer)? else {
        return Ok(None);
    };
    match opacity {
        Opacity::Number(number) => Ok(Some(number)),
        Opacity::Text(text) => {
            let text = text.trim();
            let (number, scale) = match text.strip_suffix('%') {
                Some(percent) => (percent, 100.0),
                None => (text, 1.0),
            };
            number
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .map(|value| Some(value / scale))
                .ok_or_else(|| serde::de::Error::custom(format!("opacity: expected a number or a percentage, found `{text}`")))
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::style::StyleDesc;

    fn opacity(json: &str) -> Result<Option<f64>, serde_json::Error> {
        serde_json::from_str::<StyleDesc>(json).map(|style| style.opacity)
    }

    #[test]
    fn opacity_reads_a_number_text_or_a_percentage() {
        assert_eq!(opacity(r#"{"opacity":0.5}"#).unwrap(), Some(0.5));
        assert_eq!(opacity(r#"{"opacity":" 0.25 "}"#).unwrap(), Some(0.25));
        assert_eq!(opacity(r#"{"opacity":"50%"}"#).unwrap(), Some(0.5));
        assert_eq!(opacity(r#"{"opacity":null}"#).unwrap(), None);
        assert!(opacity(r#"{"opacity":"half"}"#).is_err());
    }
}
