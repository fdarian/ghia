//! The initial value of the longhands a shorthand covers.
//!
//! A CSS-wide keyword on a longhand takes back what the cascade gave it, including the part a
//! shorthand declared earlier gave it. The cascade works on declarations, and a longhand cannot be
//! removed from a shorthand's value, so the keyword is turned into the longhand's initial value
//! written after the shorthand, which `css::covers` ranks above it.
//!
//! Only longhands with a plain initial value are here. The rest keep the keyword's old meaning,
//! which is to remove the earlier declarations of the key, and are listed in the deviations.

use std::sync::LazyLock;

use rustc_hash::FxHashMap;

use crate::css::covers::{self, KeyId};
use crate::css::lenient::Declaration;

const SIDES: [&str; 4] = ["Top", "Right", "Bottom", "Left"];
const CORNERS: [&str; 4] = ["TopLeft", "TopRight", "BottomLeft", "BottomRight"];

fn table() -> Vec<(String, &'static str)> {
    let mut rows: Vec<(String, &'static str)> = Vec::new();
    let mut row = |name: &str, value: &'static str| rows.push((name.to_owned(), value));
    for side in SIDES {
        row(&side.to_ascii_lowercase(), "\"auto\"");
        row(&format!("padding{side}"), "0");
        row(&format!("margin{side}"), "0");
        row(&format!("border{side}Width"), "\"medium\"");
        row(&format!("border{side}Style"), "\"none\"");
        row(&format!("border{side}Color"), "\"currentColor\"");
    }
    for corner in CORNERS {
        row(&format!("border{corner}Radius"), "0");
    }
    for (name, value) in [
        ("outlineWidth", "\"medium\""),
        ("outlineStyle", "\"none\""),
        ("outlineColor", "\"currentColor\""),
        ("flexGrow", "0"),
        ("flexShrink", "1"),
        ("flexBasis", "\"auto\""),
        ("flexDirection", "\"row\""),
        ("flexWrap", "\"nowrap\""),
        ("alignItems", "\"normal\""),
        ("justifyItems", "\"normal\""),
        ("alignContent", "\"normal\""),
        ("justifyContent", "\"normal\""),
        ("alignSelf", "\"auto\""),
        ("justifySelf", "\"auto\""),
        // `normal` is not a value the gap properties parse; it is zero in flex and grid layout.
        ("rowGap", "0"),
        ("columnGap", "0"),
        ("overflowX", "\"visible\""),
        ("overflowY", "\"visible\""),
        ("overscrollBehaviorX", "\"auto\""),
        ("overscrollBehaviorY", "\"auto\""),
        ("containerType", "\"normal\""),
        ("containerName", "\"none\""),
        ("gridColumnStart", "\"auto\""),
        ("gridColumnEnd", "\"auto\""),
        ("gridRowStart", "\"auto\""),
        ("gridRowEnd", "\"auto\""),
        ("transitionProperty", "\"all\""),
        ("transitionDuration", "\"0s\""),
        ("transitionTimingFunction", "\"ease\""),
        ("transitionDelay", "\"0s\""),
        ("transitionBehavior", "\"normal\""),
        ("animationName", "\"none\""),
        ("animationDuration", "\"0s\""),
        ("animationTimingFunction", "\"ease\""),
        ("animationDelay", "\"0s\""),
        ("animationIterationCount", "\"1\""),
        ("animationDirection", "\"normal\""),
        ("animationFillMode", "\"none\""),
        ("animationPlayState", "\"running\""),
        ("textDecorationLine", "\"none\""),
        ("textDecorationStyle", "\"solid\""),
        ("textDecorationColor", "\"currentColor\""),
        ("textDecorationThickness", "\"auto\""),
        ("textBoxTrim", "\"none\""),
        ("textBoxEdge", "\"auto\""),
        ("backgroundColor", "\"transparent\""),
        ("backgroundImage", "\"none\""),
        ("backgroundSize", "\"auto\""),
        ("backgroundPosition", "\"0% 0%\""),
        ("backgroundRepeat", "\"repeat\""),
        ("backgroundOrigin", "\"padding-box\""),
        ("backgroundClip", "\"border-box\""),
        ("maskImage", "\"none\""),
        ("maskSize", "\"auto\""),
        ("maskPosition", "\"0% 0%\""),
        ("maskRepeat", "\"repeat\""),
        ("maskOrigin", "\"border-box\""),
        ("maskClip", "\"border-box\""),
        ("maskMode", "\"match-source\""),
        ("maskComposite", "\"add\""),
    ] {
        row(name, value);
    }
    rows
}

static INITIAL: LazyLock<FxHashMap<KeyId, Declaration>> = LazyLock::new(|| {
    table()
        .into_iter()
        .map(|(name, value)| {
            let key = covers::key_id(&name).unwrap_or_else(|| panic!("{name} is a key of the covers table"));
            (key, Declaration { key: name, value: value.to_owned() })
        })
        .collect()
});

/// `key` at its initial value, for a longhand that has one here.
pub(super) fn of(key: KeyId) -> Option<&'static Declaration> {
    INITIAL.get(&key)
}

/// Longhands that no shorthand covers, so they are not in the table, and whose initial value the
/// style parser cannot represent.
const UNREPRESENTABLE: [(&str, &str); 1] = [("zIndex", "auto")];

/// Whether `declaration` is its property's initial value written as a keyword, which the cascade
/// then reads as `initial`. A value the style parser has no form for (`z-index: auto`) could not
/// otherwise take back an earlier rule's value.
pub(super) fn is_initial_keyword(declaration: &Declaration) -> bool {
    let Ok(written) = serde_json::from_str::<String>(&declaration.value) else {
        return false;
    };
    let written = written.trim();
    if UNREPRESENTABLE.iter().any(|(key, keyword)| *key == declaration.key && written.eq_ignore_ascii_case(keyword)) {
        return true;
    }
    covers::key_id(&declaration.key)
        .and_then(of)
        .and_then(|initial| serde_json::from_str::<String>(&initial.value).ok())
        .is_some_and(|keyword| written.eq_ignore_ascii_case(&keyword))
}

#[cfg(test)]
pub(super) fn all() -> impl Iterator<Item = &'static Declaration> {
    INITIAL.values()
}
