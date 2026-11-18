//! CSS `list-style` (CSS Lists 3): the marker of a `display: list-item` box. Which marker a
//! box gets (`list-style-type`), and on which side of the content it goes (`list-style-position`).
//!
//! `list-style-image` and the `<string>` and `symbols()` values of `list-style-type` are not
//! supported: an image is left out of the shorthand and any of the others is an invalid value.

use serde::{Deserialize, Serialize};

/// `list-style-type`. `lower-latin` and `upper-latin` are the same counter styles as
/// `lower-alpha` and `upper-alpha`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", try_from = "String")]
pub enum ListStyleType {
    Disc,
    Circle,
    Square,
    Decimal,
    LowerAlpha,
    UpperAlpha,
    LowerRoman,
    UpperRoman,
    None,
}

impl TryFrom<String> for ListStyleType {
    type Error = String;

    fn try_from(value: String) -> Result<Self, String> {
        Self::parse(&value).ok_or_else(|| format!("invalid listStyleType: {value:?}"))
    }
}

impl ListStyleType {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "disc" => Self::Disc,
            "circle" => Self::Circle,
            "square" => Self::Square,
            "decimal" => Self::Decimal,
            "lower-alpha" | "lower-latin" => Self::LowerAlpha,
            "upper-alpha" | "upper-latin" => Self::UpperAlpha,
            "lower-roman" => Self::LowerRoman,
            "upper-roman" => Self::UpperRoman,
            "none" => Self::None,
            _ => return None,
        })
    }

    fn keyword(self) -> &'static str {
        match self {
            Self::Disc => "disc",
            Self::Circle => "circle",
            Self::Square => "square",
            Self::Decimal => "decimal",
            Self::LowerAlpha => "lower-alpha",
            Self::UpperAlpha => "upper-alpha",
            Self::LowerRoman => "lower-roman",
            Self::UpperRoman => "upper-roman",
            Self::None => "none",
        }
    }

    /// Whether the marker is a number of the list: a change of the items before it changes it.
    pub(crate) fn is_ordinal(self) -> bool {
        !matches!(self, Self::Disc | Self::Circle | Self::Square | Self::None)
    }

    /// The marker as Chrome generates it: the symbol or the counter with its suffix, and a space. A symbol is
    /// what the marker reads out and measures by: Chrome paints it as a shape (`layout::list_marker_paint`).
    /// `None` for `none`. The counter of a type that cannot show it (roman past 3999, alphabetic
    /// below 1) is shown as `decimal` does.
    pub(crate) fn marker_text(self, ordinal: i64) -> Option<String> {
        Some(match self {
            Self::None => return None,
            Self::Disc => "\u{2022} ".to_string(),
            Self::Circle => "\u{25E6} ".to_string(),
            Self::Square => "\u{25AA} ".to_string(),
            Self::Decimal => format!("{ordinal}. "),
            Self::LowerAlpha => alphabetic(ordinal, b'a').map_or_else(|| format!("{ordinal}. "), |text| format!("{text}. ")),
            Self::UpperAlpha => alphabetic(ordinal, b'A').map_or_else(|| format!("{ordinal}. "), |text| format!("{text}. ")),
            Self::LowerRoman => roman(ordinal, true).map_or_else(|| format!("{ordinal}. "), |text| format!("{text}. ")),
            Self::UpperRoman => roman(ordinal, false).map_or_else(|| format!("{ordinal}. "), |text| format!("{text}. ")),
        })
    }
}

/// `list-style-position`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", try_from = "String")]
pub enum ListStylePosition {
    Outside,
    Inside,
}

impl TryFrom<String> for ListStylePosition {
    type Error = String;

    fn try_from(value: String) -> Result<Self, String> {
        Self::parse(&value).ok_or_else(|| format!("invalid listStylePosition: {value:?}"))
    }
}

impl ListStylePosition {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "outside" => Some(Self::Outside),
            "inside" => Some(Self::Inside),
            _ => None,
        }
    }

    fn keyword(self) -> &'static str {
        match self {
            Self::Outside => "outside",
            Self::Inside => "inside",
        }
    }
}

/// The `list-style` shorthand: `<'list-style-position'> || <'list-style-image'> ||
/// <'list-style-type'>`, where what the value leaves out is the longhand's initial value, `disc`
/// and `outside`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ListStyle {
    pub list_type: ListStyleType,
    pub position: ListStylePosition,
}

impl TryFrom<String> for ListStyle {
    type Error = String;

    fn try_from(value: String) -> Result<Self, String> {
        let invalid = || format!("invalid listStyle: {value:?}");
        let mut list_type = None;
        let mut position = None;
        let mut nones = 0;
        let mut keywords = 0;
        for keyword in crate::css::syntax::split_whitespace(&value) {
            keywords += 1;
            if keyword == "none" {
                nones += 1;
            } else if let Some(parsed) = ListStyleType::parse(keyword) {
                if list_type.replace(parsed).is_some() {
                    return Err(invalid());
                }
            } else if let Some(parsed) = ListStylePosition::parse(keyword) {
                if position.replace(parsed).is_some() {
                    return Err(invalid());
                }
            } else if !keyword.starts_with("url(") {
                return Err(invalid());
            }
        }
        // `none` is the type, the image, or both: with a type written, it is the image.
        let none_is_type = match (nones, list_type) {
            (0, _) => false,
            (1, None) | (2, None) => true,
            (1, Some(_)) => false,
            _ => return Err(invalid()),
        };
        if keywords == 0 {
            return Err(invalid());
        }
        Ok(Self {
            list_type: if none_is_type { ListStyleType::None } else { list_type.unwrap_or(ListStyleType::Disc) },
            position: position.unwrap_or(ListStylePosition::Outside),
        })
    }
}

impl From<ListStyle> for String {
    fn from(value: ListStyle) -> String {
        format!("{} {}", value.position.keyword(), value.list_type.keyword())
    }
}

/// The `list-style-type` an element declares: the longhand, else the shorthand's.
pub(crate) fn declared_type(style: &crate::style::StyleDesc) -> Option<ListStyleType> {
    style.list_style_type.or(style.list_style.map(|shorthand| shorthand.list_type))
}

/// The `list-style-position` an element declares: the longhand, else the shorthand's.
pub(crate) fn declared_position(style: &crate::style::StyleDesc) -> Option<ListStylePosition> {
    style.list_style_position.or(style.list_style.map(|shorthand| shorthand.position))
}

/// The CSS `alphabetic` system: `a`, ..., `z`, `aa`, `ab`, ..., with no zero. It has no
/// representation below 1.
fn alphabetic(ordinal: i64, first: u8) -> Option<String> {
    if ordinal < 1 {
        return None;
    }
    let mut digits = Vec::new();
    let mut rest = ordinal;
    while rest > 0 {
        rest -= 1;
        digits.push(first + (rest % 26) as u8);
        rest /= 26;
    }
    digits.reverse();
    Some(String::from_utf8(digits).expect("ASCII letters"))
}

/// The CSS `additive` roman numerals, which stop at 3999.
fn roman(ordinal: i64, lower: bool) -> Option<String> {
    if !(1..=3999).contains(&ordinal) {
        return None;
    }
    const NUMERALS: [(i64, &str); 13] = [
        (1000, "M"),
        (900, "CM"),
        (500, "D"),
        (400, "CD"),
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ];
    let mut text = String::new();
    let mut rest = ordinal;
    for (value, numeral) in NUMERALS {
        while rest >= value {
            text.push_str(numeral);
            rest -= value;
        }
    }
    Some(if lower { text.to_ascii_lowercase() } else { text })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shorthand(text: &str) -> Result<ListStyle, serde_json::Error> {
        serde_json::from_str(&format!("{text:?}"))
    }

    #[test]
    fn the_shorthand_takes_a_type_a_position_or_both_in_either_order() {
        use ListStylePosition::{Inside, Outside};
        use ListStyleType::*;
        for (text, list_type, position) in [
            ("square", Square, Outside),
            ("inside", Disc, Inside),
            ("inside decimal", Decimal, Inside),
            ("lower-roman inside", LowerRoman, Inside),
            ("none", None, Outside),
            ("none inside", None, Inside),
            ("none none", None, Outside),
            ("square none", Square, Outside),
            ("none upper-latin", UpperAlpha, Outside),
            ("url(a.png) circle", Circle, Outside),
            ("url(\"a b.png\") inside", Disc, Inside),
        ] {
            assert_eq!(shorthand(text).unwrap(), ListStyle { list_type, position }, "{text}");
        }
    }

    #[test]
    fn a_shorthand_that_names_a_thing_twice_or_unknown_is_invalid() {
        for text in ["", "disc square", "inside outside", "none none none", "disc none none", "bullet", "\"-\"", "symbols(cyclic \"*\")"] {
            assert!(shorthand(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn the_longhands_take_their_keywords_and_nothing_else() {
        for (keyword, expected) in [
            ("disc", ListStyleType::Disc),
            ("circle", ListStyleType::Circle),
            ("square", ListStyleType::Square),
            ("decimal", ListStyleType::Decimal),
            ("lower-alpha", ListStyleType::LowerAlpha),
            ("lower-latin", ListStyleType::LowerAlpha),
            ("upper-alpha", ListStyleType::UpperAlpha),
            ("upper-latin", ListStyleType::UpperAlpha),
            ("lower-roman", ListStyleType::LowerRoman),
            ("upper-roman", ListStyleType::UpperRoman),
            ("none", ListStyleType::None),
        ] {
            assert_eq!(serde_json::from_str::<ListStyleType>(&format!("{keyword:?}")).unwrap(), expected);
        }
        for json in [r#""greek""#, r#""\"*\"""#, r#""symbols(cyclic \"*\")""#, "1", r#""Disc""#] {
            assert!(serde_json::from_str::<ListStyleType>(json).is_err(), "{json}");
        }
        assert_eq!(serde_json::from_str::<ListStylePosition>(r#""inside""#).unwrap(), ListStylePosition::Inside);
        assert!(serde_json::from_str::<ListStylePosition>(r#""outer""#).is_err());
    }

    #[test]
    fn a_style_reads_them_and_an_invalid_one_is_not_interned() {
        let style: crate::style::StyleDesc =
            serde_json::from_str(r#"{"listStyle": "inside square", "listStyleType": "decimal", "listStylePosition": "outside"}"#).unwrap();
        assert_eq!(style.list_style_type, Some(ListStyleType::Decimal));
        assert_eq!(style.list_style_position, Some(ListStylePosition::Outside));
        assert_eq!(style.list_style, Some(ListStyle { list_type: ListStyleType::Square, position: ListStylePosition::Inside }));
        assert_eq!(declared_type(&style), Some(ListStyleType::Decimal), "the longhand wins");
        assert_eq!(declared_position(&style), Some(ListStylePosition::Outside));

        let mut table = crate::retained_tree::StyleTable::default();
        for json in [
            &br#"{"listStyle": "disc square", "opacity": 0.5}"#[..],
            &br#"{"listStyleType": "greek", "opacity": 0.5}"#[..],
            &br#"{"listStylePosition": "middle", "opacity": 0.5}"#[..],
        ] {
            let style = table.intern(json).unwrap();
            assert_eq!((style.list_style, style.list_style_type, style.list_style_position), (None, None, None), "{}", String::from_utf8_lossy(json));
            assert_eq!(style.opacity, Some(0.5));
        }
    }

    #[test]
    fn the_shorthand_alone_declares_both_and_a_longhand_before_it_is_covered() {
        let style: crate::style::StyleDesc = serde_json::from_str(r#"{"listStyle": "inside"}"#).unwrap();
        assert_eq!(declared_type(&style), Some(ListStyleType::Disc));
        assert_eq!(declared_position(&style), Some(ListStylePosition::Inside));
        assert_eq!(declared_type(&crate::style::StyleDesc::default()), None);
    }

    #[test]
    fn the_shorthand_survives_a_round_trip() {
        let value = ListStyle { list_type: ListStyleType::LowerRoman, position: ListStylePosition::Inside };
        let json = serde_json::to_string(&value).unwrap();
        assert_eq!(serde_json::from_str::<ListStyle>(&json).unwrap(), value);
    }

    #[test]
    fn bullets_are_a_symbol_and_a_space() {
        assert_eq!(ListStyleType::Disc.marker_text(7).as_deref(), Some("\u{2022} "));
        assert_eq!(ListStyleType::Circle.marker_text(7).as_deref(), Some("\u{25E6} "));
        assert_eq!(ListStyleType::Square.marker_text(7).as_deref(), Some("\u{25AA} "));
        assert_eq!(ListStyleType::None.marker_text(7), None);
    }

    #[test]
    fn decimal_has_no_range() {
        assert_eq!(ListStyleType::Decimal.marker_text(12).as_deref(), Some("12. "));
        assert_eq!(ListStyleType::Decimal.marker_text(0).as_deref(), Some("0. "));
        assert_eq!(ListStyleType::Decimal.marker_text(-3).as_deref(), Some("-3. "));
    }

    #[test]
    fn alphabetic_counts_a_to_z_then_aa() {
        let lower = |n| ListStyleType::LowerAlpha.marker_text(n).unwrap();
        assert_eq!(lower(1), "a. ");
        assert_eq!(lower(26), "z. ");
        assert_eq!(lower(27), "aa. ");
        assert_eq!(lower(52), "az. ");
        assert_eq!(lower(53), "ba. ");
        assert_eq!(lower(702), "zz. ");
        assert_eq!(lower(703), "aaa. ");
        assert_eq!(ListStyleType::UpperAlpha.marker_text(28).unwrap(), "AB. ");
        assert_eq!(lower(0), "0. ", "no letters for zero");
        assert_eq!(lower(-1), "-1. ");
    }

    #[test]
    fn roman_stops_at_3999_and_falls_back_to_decimal() {
        let lower = |n| ListStyleType::LowerRoman.marker_text(n).unwrap();
        assert_eq!(lower(1), "i. ");
        assert_eq!(lower(4), "iv. ");
        assert_eq!(lower(9), "ix. ");
        assert_eq!(lower(14), "xiv. ");
        assert_eq!(lower(1994), "mcmxciv. ");
        assert_eq!(lower(3999), "mmmcmxcix. ");
        assert_eq!(lower(4000), "4000. ");
        assert_eq!(lower(0), "0. ");
        assert_eq!(ListStyleType::UpperRoman.marker_text(2024).unwrap(), "MMXXIV. ");
    }

    #[test]
    fn only_the_counting_types_are_ordinal() {
        assert!(ListStyleType::Decimal.is_ordinal() && ListStyleType::LowerAlpha.is_ordinal() && ListStyleType::UpperRoman.is_ordinal());
        assert!(!ListStyleType::Disc.is_ordinal() && !ListStyleType::None.is_ordinal());
    }
}
