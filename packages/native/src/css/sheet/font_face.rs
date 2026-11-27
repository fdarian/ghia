//! `@font-face { font-family; src; font-weight; font-style; font-stretch; unicode-range; font-display }`:
//! the face a sheet declares.
//!
//! This file reads the rule. Loading the bytes and registering them with the text system is
//! `text/font_faces.rs`, because it needs the window's text system, which a sheet load does not
//! have. A rule is kept when it names a family and has at least one valid `src` item; a descriptor
//! that is not valid is ignored and keeps its default, as CSS Fonts 4 asks. Which faces of a name
//! hold in the window is `definitions::winners`, told apart by [`FontFaceRule::identity`].

use std::sync::Arc;

use crate::css::syntax::{split_commas, split_whitespace};
use crate::css::url;

use super::keyframes::split_declarations;
use super::tokenizer::{trim, Kind, Token};

/// The `format()` hints of a source this engine can load, and what `@supports font-format()` answers for.
pub(crate) const SUPPORTED_FORMATS: [&str; 5] = ["truetype", "opentype", "collection", "truetype-variations", "opentype-variations"];

/// The `tech()` keywords of a source this engine can use, and what `@supports font-tech()` answers for: the
/// text system applies OpenType features and variation axes, and has no colour glyph formats.
pub(crate) const SUPPORTED_TECHS: [&str; 2] = ["variations", "features-opentype"];

#[derive(Debug, Clone, PartialEq)]
pub enum FaceSource {
    /// An address as written in `url()`, read as an `<img>` `src` is. `format` is the lowercased `format()` hint.
    Url { address: String, format: Option<String> },
    /// A font installed on the system, by family name.
    Local(String),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FaceStyle {
    Normal,
    Italic,
    Oblique,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FontFaceRule {
    /// As written (quotes and escapes resolved); families are compared without case.
    pub family: String,
    pub sources: Vec<FaceSource>,
    /// The weights the face covers, `(400, 400)` for the descriptor's initial value.
    pub weight: (f32, f32),
    pub style: FaceStyle,
    /// In percent, `(100, 100)` for `normal`.
    pub stretch: (f32, f32),
    /// The `unicode-range` descriptor, normalized; only part of the identity, as no face is a subset here.
    pub unicode_range: Option<String>,
    /// What two rules have to share for the later one to replace the earlier (`definitions::winners`).
    pub identity: String,
}

/// The faces the document's sheets declare that hold in the window, one for each [`FontFaceRule::identity`],
/// with a number that changes whenever the set does. The text system reads it (`text/font_faces.rs`).
#[derive(Default)]
pub struct SheetFontFaces {
    epoch: u64,
    rules: Vec<Arc<FontFaceRule>>,
}

impl SheetFontFaces {
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(crate) fn rules(&self) -> &[Arc<FontFaceRule>] {
        &self.rules
    }

    #[cfg(test)]
    pub(crate) fn for_test(epoch: u64, rules: Vec<Arc<FontFaceRule>>) -> SheetFontFaces {
        SheetFontFaces { epoch, rules }
    }

    /// The set after `winners` replaced the definitions, which is this one when they are the same.
    pub(super) fn replaced_by(current: &Arc<SheetFontFaces>, winners: Vec<&Arc<FontFaceRule>>) -> Option<Arc<SheetFontFaces>> {
        let same = winners.len() == current.rules.len()
            && winners.iter().zip(&current.rules).all(|(new, held)| Arc::ptr_eq(new, held) || ***new == **held);
        (!same).then(|| Arc::new(SheetFontFaces { epoch: current.epoch + 1, rules: winners.into_iter().cloned().collect() }))
    }
}

/// The rule `@font-face { <contents> }` makes, or the reason it makes none.
pub(super) fn parse(src: &str, contents: &[Token]) -> Result<FontFaceRule, String> {
    let mut family = None;
    let mut sources = None;
    let mut weight = (400.0, 400.0);
    let mut style = FaceStyle::Normal;
    let mut stretch = (100.0, 100.0);
    let mut unicode_range = None;
    for piece in split_declarations(contents) {
        let piece = trim(piece);
        let [first, rest @ ..] = piece else {
            continue;
        };
        let Kind::Ident(descriptor) = &first.kind else {
            continue;
        };
        let rest = trim(rest);
        let [colon, value @ ..] = rest else {
            continue;
        };
        if colon.kind != Kind::Colon {
            continue;
        }
        let value = trim(value);
        let (Some(from), Some(to)) = (value.first(), value.last()) else {
            continue;
        };
        let text = &src[from.start..to.end];
        match descriptor.to_ascii_lowercase().as_str() {
            "font-family" => family = family_name(value).or(family),
            "src" => {
                let parsed = parse_sources(text);
                if !parsed.is_empty() {
                    sources = Some(parsed);
                }
            }
            "font-weight" => weight = weight_range(text).unwrap_or(weight),
            "font-style" => style = face_style(text).unwrap_or(style),
            "font-stretch" | "font-width" => stretch = stretch_range(text).unwrap_or(stretch),
            "unicode-range" => unicode_range = normalize_unicode_range(text).or(unicode_range),
            _ => {}
        }
    }
    let Some(family) = family else {
        return Err("no valid font-family".to_owned());
    };
    let Some(sources) = sources else {
        return Err("no valid src".to_owned());
    };
    let identity = format!(
        "{}|{}-{}|{:?}|{}-{}|{}",
        family.to_lowercase(),
        weight.0,
        weight.1,
        style,
        stretch.0,
        stretch.1,
        unicode_range.as_deref().unwrap_or("")
    );
    Ok(FontFaceRule { family, sources, weight, style, stretch, unicode_range, identity })
}

/// A string, or a run of identifiers joined by single spaces. A generic family or a CSS-wide
/// keyword is not a name a face can take.
fn family_name(value: &[Token]) -> Option<String> {
    if let [token] = value {
        if let Kind::Str(name) = &token.kind {
            return (!name.is_empty()).then(|| name.clone());
        }
    }
    let mut words = Vec::new();
    for token in value {
        match &token.kind {
            Kind::Ident(word) => words.push(word.as_str()),
            Kind::Whitespace => {}
            _ => return None,
        }
    }
    const RESERVED: [&str; 19] = [
        "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
        "emoji", "math", "fangsong", "inherit", "initial", "unset", "revert", "revert-layer", "default",
    ];
    match words.as_slice() {
        [] => None,
        [only] if RESERVED.iter().any(|reserved| reserved.eq_ignore_ascii_case(only)) => None,
        words => Some(words.join(" ")),
    }
}

/// The valid items of a `src` list, in order: `url(...)` and `local(...)`, each optionally followed
/// by `format()` and `tech()`; an item that needs a technology the text system lacks is skipped.
fn parse_sources(text: &str) -> Vec<FaceSource> {
    split_commas(text).into_iter().filter_map(parse_source).collect()
}

fn parse_source(item: &str) -> Option<FaceSource> {
    let mut words = split_whitespace(item).into_iter();
    let head = words.next()?;
    let mut format = None;
    for word in words {
        if let Some(arguments) = crate::css::syntax::function_args(word, "format") {
            format = Some(unquote(arguments)?.to_ascii_lowercase());
        } else if let Some(technologies) = crate::css::syntax::function_args(word, "tech") {
            if !split_commas(technologies).into_iter().all(|tech| SUPPORTED_TECHS.iter().any(|known| known.eq_ignore_ascii_case(tech.trim()))) {
                return None;
            }
        } else {
            return None;
        }
    }
    match url::parse(head) {
        url::Parsed::Url(address) if !address.is_empty() => return Some(FaceSource::Url { address: address.into_owned(), format }),
        url::Parsed::Url(_) | url::Parsed::Invalid => return None,
        url::Parsed::NotUrl => {}
    }
    let name = crate::css::syntax::function_args(head, "local")?;
    if format.is_some() {
        return None;
    }
    let name = local_name(name)?;
    Some(FaceSource::Local(name))
}

/// `"Name"`, `'Name'` or a run of identifiers.
fn local_name(argument: &str) -> Option<String> {
    let argument = argument.trim();
    if let Some(name) = quoted(argument) {
        return (!name.is_empty()).then(|| name.to_owned());
    }
    let words: Vec<&str> = argument.split_whitespace().collect();
    (!words.is_empty() && words.iter().all(|word| !word.contains(['"', '\'', '(', ')', ','])))
        .then(|| words.join(" "))
}

/// A `format()` argument: a string or an identifier.
fn unquote(argument: &str) -> Option<&str> {
    let argument = argument.trim();
    quoted(argument).or_else(|| (!argument.is_empty() && !argument.contains(char::is_whitespace)).then_some(argument))
}

fn quoted(text: &str) -> Option<&str> {
    let quote = text.chars().next().filter(|character| matches!(character, '"' | '\''))?;
    text.strip_prefix(quote)?.strip_suffix(quote)
}

/// `auto`, or one or two of `normal`, `bold` and numbers from 1 to 1000 (a range for a variable font).
fn weight_range(text: &str) -> Option<(f32, f32)> {
    let words = split_whitespace(text);
    let value = |word: &str| match word.to_ascii_lowercase().as_str() {
        "normal" | "auto" => Some(400.0),
        "bold" => Some(700.0),
        number => number.parse::<f32>().ok().filter(|number| (1.0..=1000.0).contains(number)),
    };
    match words.as_slice() {
        [one] => value(one).map(|weight| (weight, weight)),
        [from, to] => {
            let (from, to) = (value(from)?, value(to)?);
            Some((from.min(to), from.max(to)))
        }
        _ => None,
    }
}

/// `normal`, `italic`, `auto`, or `oblique` with up to two angles.
fn face_style(text: &str) -> Option<FaceStyle> {
    let words = split_whitespace(text);
    let (first, angles) = words.split_first()?;
    match first.to_ascii_lowercase().as_str() {
        "normal" | "auto" if angles.is_empty() => Some(FaceStyle::Normal),
        "italic" if angles.is_empty() => Some(FaceStyle::Italic),
        "oblique" if angles.len() <= 2 && angles.iter().all(|angle| is_angle(angle)) => Some(FaceStyle::Oblique),
        _ => None,
    }
}

fn is_angle(word: &str) -> bool {
    let word = word.to_ascii_lowercase();
    ["deg", "grad", "rad", "turn"]
        .iter()
        .find_map(|unit| word.strip_suffix(unit))
        .is_some_and(|number| number.parse::<f32>().is_ok())
}

/// A keyword, or one or two percentages, in percent.
fn stretch_range(text: &str) -> Option<(f32, f32)> {
    let words = split_whitespace(text);
    let value = |word: &str| match word.to_ascii_lowercase().as_str() {
        "auto" | "normal" => Some(100.0),
        "ultra-condensed" => Some(50.0),
        "extra-condensed" => Some(62.5),
        "condensed" => Some(75.0),
        "semi-condensed" => Some(87.5),
        "semi-expanded" => Some(112.5),
        "expanded" => Some(125.0),
        "extra-expanded" => Some(150.0),
        "ultra-expanded" => Some(200.0),
        percentage => percentage.strip_suffix('%')?.parse::<f32>().ok().filter(|percent| *percent >= 0.0),
    };
    match words.as_slice() {
        [one] => value(one).map(|stretch| (stretch, stretch)),
        [from, to] => {
            let (from, to) = (value(from)?, value(to)?);
            Some((from.min(to), from.max(to)))
        }
        _ => None,
    }
}

/// A comma list of `U+26`, `U+0-7F`, `U+4??`; the list is all or nothing, as one invalid item
/// makes the descriptor invalid.
fn normalize_unicode_range(text: &str) -> Option<String> {
    let ranges: Vec<String> = split_commas(text)
        .into_iter()
        .map(|item| {
            let digits = item.strip_prefix("U+").or_else(|| item.strip_prefix("u+"))?;
            // The wildcard split below cuts by bytes, which is only a cut of characters in ASCII.
            if !digits.is_ascii() {
                return None;
            }
            let valid_run = |run: &str| (1..=6).contains(&run.len()) && run.chars().all(|c| c.is_ascii_hexdigit());
            let valid = match digits.split_once('-') {
                Some((from, to)) => valid_run(from) && valid_run(to),
                None => {
                    let wildcards = digits.chars().filter(|c| *c == '?').count();
                    let (head, tail) = digits.split_at(digits.len() - wildcards);
                    (1..=6).contains(&digits.len()) && tail.chars().all(|c| c == '?') && head.chars().all(|c| c.is_ascii_hexdigit())
                }
            };
            valid.then(|| format!("U+{}", digits.to_ascii_uppercase()))
        })
        .collect::<Option<_>>()?;
    (!ranges.is_empty()).then(|| ranges.join(", "))
}

/// The faces the rules of `css` make, for tests of what loads them.
#[cfg(test)]
pub(crate) fn faces_for_tests(css: &str, epoch: u64) -> Arc<SheetFontFaces> {
    use super::atoms::Atoms;
    use super::layers::Layers;
    use super::validate::Validator;

    let sheet = super::parse_sheet(css, &mut Atoms::default(), &mut Layers::default(), &mut Validator::default());
    Arc::new(SheetFontFaces::for_test(epoch, sheet.font_faces.iter().map(|face| face.body.clone()).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::css::sheet::atoms::Atoms;
    use crate::css::sheet::layers::Layers;
    use crate::css::sheet::validate::Validator;
    use crate::css::sheet::{parse_sheet, StyleSheet};

    fn sheet(text: &str) -> StyleSheet {
        parse_sheet(text, &mut Atoms::default(), &mut Layers::default(), &mut Validator::default())
    }

    fn only(text: &str) -> FontFaceRule {
        let sheet = sheet(text);
        assert_eq!(sheet.font_faces.len(), 1, "{:?}", sheet.unsupported);
        (*sheet.font_faces[0].body).clone()
    }

    #[test]
    fn reads_every_descriptor() {
        let rule = only(
            r#"@font-face {
                font-family: "Fira Code";
                src: url("fonts/fira.woff2") format("woff2"), url(fira.ttf) format(truetype), local(Fira Mono);
                font-weight: 300 700;
                font-style: oblique 10deg 20deg;
                font-stretch: 75% 125%;
                unicode-range: U+0-7F, u+4??;
                font-display: swap;
            }"#,
        );
        assert_eq!(rule.family, "Fira Code");
        assert_eq!(
            rule.sources,
            vec![
                FaceSource::Url { address: "fonts/fira.woff2".into(), format: Some("woff2".into()) },
                FaceSource::Url { address: "fira.ttf".into(), format: Some("truetype".into()) },
                FaceSource::Local("Fira Mono".into()),
            ]
        );
        assert_eq!(rule.weight, (300.0, 700.0));
        assert_eq!(rule.style, FaceStyle::Oblique);
        assert_eq!(rule.stretch, (75.0, 125.0));
        assert_eq!(rule.unicode_range.as_deref(), Some("U+0-7F, U+4??"));
    }

    #[test]
    fn descriptors_have_their_initial_values() {
        let rule = only("@font-face { font-family: Foo; src: url(a.ttf) }");
        assert_eq!((rule.weight, rule.style, rule.stretch), ((400.0, 400.0), FaceStyle::Normal, (100.0, 100.0)));
        assert_eq!(rule.unicode_range, None);
    }

    #[test]
    fn a_single_weight_and_the_keywords() {
        assert_eq!(only("@font-face { font-family: A; src: url(a); font-weight: bold }").weight, (700.0, 700.0));
        assert_eq!(only("@font-face { font-family: A; src: url(a); font-weight: 550 }").weight, (550.0, 550.0));
        assert_eq!(only("@font-face { font-family: A; src: url(a); font-style: italic }").style, FaceStyle::Italic);
        assert_eq!(only("@font-face { font-family: A; src: url(a); font-stretch: condensed }").stretch, (75.0, 75.0));
    }

    #[test]
    fn an_invalid_descriptor_keeps_its_default() {
        let rule = only(
            "@font-face { font-family: A; src: url(a); font-weight: heavy; font-style: slanted; font-stretch: wide; unicode-range: nope; font-weight: 0 }",
        );
        assert_eq!((rule.weight, rule.style, rule.stretch, rule.unicode_range), ((400.0, 400.0), FaceStyle::Normal, (100.0, 100.0), None));
    }

    #[test]
    fn invalid_source_items_are_dropped_and_the_rest_stay() {
        let rule = only("@font-face { font-family: A; src: nonsense, url(a.ttf) bogus, url(b.ttf), url() , local() }");
        assert_eq!(rule.sources, vec![FaceSource::Url { address: "b.ttf".into(), format: None }]);
    }

    #[test]
    fn a_quoted_address_keeps_its_commas_and_spaces() {
        let rule = only("@font-face { font-family: A; src: url('a, b (1).ttf') }");
        assert_eq!(rule.sources, vec![FaceSource::Url { address: "a, b (1).ttf".into(), format: None }]);
    }

    #[test]
    fn a_rule_without_family_or_src_is_dropped_and_recorded() {
        let parsed = sheet("@font-face { src: url(a.ttf) } @font-face { font-family: A } @font-face { font-family: serif; src: url(a.ttf) } @font-face { font-family: A; src: nope }");
        assert!(parsed.font_faces.is_empty());
        assert_eq!(
            parsed.unsupported,
            vec![
                "@font-face: no valid font-family",
                "@font-face: no valid src",
                "@font-face: no valid font-family",
                "@font-face: no valid src"
            ]
        );
    }

    #[test]
    fn a_non_ascii_unicode_range_is_invalid_and_does_not_panic() {
        let rule = only("@font-face { font-family: A; src: url(a); unicode-range: U+é }");
        assert_eq!(rule.unicode_range, None);
        let rule = only("@font-face { font-family: A; src: url(a); unicode-range: U+4?\u{e9}, U+0-7F }");
        assert_eq!(rule.unicode_range, None);
    }

    #[test]
    fn weight_ranges_take_the_keywords() {
        assert_eq!(only("@font-face { font-family: A; src: url(a); font-weight: normal bold }").weight, (400.0, 700.0));
        assert_eq!(only("@font-face { font-family: A; src: url(a); font-weight: bold 300 }").weight, (300.0, 700.0));
        assert_eq!(only("@font-face { font-family: A; src: url(a); font-weight: auto auto }").weight, (400.0, 400.0));
    }

    #[test]
    fn css_wide_keywords_and_generic_families_are_not_face_names() {
        for name in ["revert", "revert-layer", "math", "emoji", "fangsong", "REVERT"] {
            let parsed = sheet(&format!("@font-face {{ font-family: {name}; src: url(a) }}"));
            assert!(parsed.font_faces.is_empty(), "{name}");
        }
    }

    #[test]
    fn a_source_needing_a_technology_the_text_system_lacks_is_skipped() {
        let rule = only(
            "@font-face { font-family: A; src: url(a.ttf) tech(color-COLRv1), url(b.ttf) tech(variations), url(c.ttf) tech(variations, features-opentype), url(d.ttf) tech(variations, palettes) }",
        );
        assert_eq!(
            rule.sources,
            vec![FaceSource::Url { address: "b.ttf".into(), format: None }, FaceSource::Url { address: "c.ttf".into(), format: None }]
        );
    }

    #[test]
    fn a_rule_without_a_block_is_dropped() {
        let parsed = sheet("@font-face; .a { top: 1px }");
        assert!(parsed.font_faces.is_empty());
        assert_eq!(parsed.rules.len(), 1);
    }

    #[test]
    fn family_names_join_identifiers_and_compare_without_case() {
        let rule = only("@font-face { font-family: My  Font; src: url(a) }");
        assert_eq!(rule.family, "My Font");
        let upper = only("@font-face { font-family: MY FONT; src: url(a) }");
        assert_eq!(rule.identity, upper.identity);
    }

    #[test]
    fn the_conditions_and_layer_of_the_block_are_kept() {
        let parsed = sheet(
            "@media (min-width: 500px) { @font-face { font-family: A; src: url(a) } }
             @layer base { @font-face { font-family: B; src: url(b) } }
             @supports (display: grid) { @font-face { font-family: C; src: url(c) } }
             @supports (nonsense: 1) { @font-face { font-family: D; src: url(d) } }",
        );
        let names: Vec<(&str, bool, bool)> =
            parsed.font_faces.iter().map(|face| (face.body.family.as_str(), face.conditions.is_some(), face.layer.is_some())).collect();
        assert_eq!(names, vec![("A", true, false), ("B", false, true), ("C", false, false)]);
    }

    #[test]
    fn a_font_face_inside_a_style_rule_is_skipped() {
        let parsed = sheet(".a { color: red; @font-face { font-family: A; src: url(a) } }");
        assert!(parsed.font_faces.is_empty());
    }
}
