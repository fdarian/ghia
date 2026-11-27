//! Registered custom properties: what `@property` declares for a `--name`.
//!
//! A registration has a syntax, whether the property inherits, and an initial value. Two things of
//! it take effect (`CustomProperties`): the initial value is what `var(--name)` reads on an element
//! nothing set it on, and a property that does not inherit is not handed down: an element that
//! does not declare it computes the initial value, whatever its parent has.
//!
//! The syntax is parsed into a grammar and the initial value is checked against it, as the rule is
//! invalid without a match. A value an element declares is not matched against the grammar, and a
//! registered property is not interpolated by its type: both are in `docs/fork/deviations.md`.

use rustc_hash::FxHashMap;

use crate::color::{resolve_color, ColorContext, Scheme};
use crate::css::custom_properties::{is_name, normalise};
use crate::css::syntax::{function_args, split_commas};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Registration {
    /// With the `--`.
    pub name: String,
    pub syntax: Syntax,
    pub inherits: bool,
    /// The initial value as written, normalised. `None` for the universal syntax with no value: the
    /// property is guaranteed-invalid until something sets it.
    pub initial: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Syntax {
    /// `*`: any value.
    Universal,
    /// The alternatives of `a | <length>+ | <color>#`, as the grammar lists them.
    Alternatives(Vec<Component>),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Component {
    pub kind: Kind,
    pub multiplier: Multiplier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Multiplier {
    One,
    /// `+`: values separated by spaces.
    Spaces,
    /// `#`: values separated by commas.
    Commas,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Kind {
    /// A keyword, which matches itself, case-sensitively.
    Ident(String),
    Length,
    Number,
    Percentage,
    LengthPercentage,
    Color,
    Image,
    Url,
    Integer,
    Angle,
    Time,
    Resolution,
    TransformFunction,
    CustomIdent,
}

impl Syntax {
    /// The grammar of a `syntax` descriptor, which is the text between its quotes. `None` when it is
    /// not one: nothing but `*`, or a list of components separated by `|`.
    pub(crate) fn parse(text: &str) -> Option<Syntax> {
        let text = text.trim_matches(|c: char| c.is_ascii_whitespace());
        if text == "*" {
            return Some(Syntax::Universal);
        }
        let alternatives: Option<Vec<Component>> = text.split('|').map(parse_component).collect();
        let alternatives = alternatives.filter(|list| !list.is_empty())?;
        Some(Syntax::Alternatives(alternatives))
    }

    /// Whether `value` is one of the grammar's values.
    pub(crate) fn matches(&self, value: &str) -> bool {
        match self {
            Syntax::Universal => true,
            Syntax::Alternatives(alternatives) => {
                let value = value.trim();
                alternatives.iter().any(|component| component.matches(value))
            }
        }
    }
}

fn parse_component(text: &str) -> Option<Component> {
    let text = text.trim_matches(|c: char| c.is_ascii_whitespace());
    let Some(rest) = text.strip_prefix('<') else {
        return is_ident(text).then(|| Component { kind: Kind::Ident(text.to_owned()), multiplier: Multiplier::One });
    };
    let (name, after) = rest.split_once('>')?;
    let multiplier = match after {
        "" => Multiplier::One,
        "+" => Multiplier::Spaces,
        "#" => Multiplier::Commas,
        _ => return None,
    };
    let kind = match name {
        "length" => Kind::Length,
        "number" => Kind::Number,
        "percentage" => Kind::Percentage,
        "length-percentage" => Kind::LengthPercentage,
        "color" => Kind::Color,
        "image" => Kind::Image,
        "url" => Kind::Url,
        "integer" => Kind::Integer,
        "angle" => Kind::Angle,
        "time" => Kind::Time,
        "resolution" => Kind::Resolution,
        "transform-function" => Kind::TransformFunction,
        "custom-ident" => Kind::CustomIdent,
        // `<transform-list>` is `<transform-function>+` and takes no multiplier of its own.
        "transform-list" if multiplier == Multiplier::One => {
            return Some(Component { kind: Kind::TransformFunction, multiplier: Multiplier::Spaces });
        }
        _ => return None,
    };
    Some(Component { kind, multiplier })
}

/// A CSS identifier that the grammar may use as a keyword: not a CSS-wide keyword or `default`.
fn is_ident(text: &str) -> bool {
    let mut characters = text.chars();
    let starts_well = match characters.next() {
        Some('-') => characters.next().is_some_and(|second| second.is_alphabetic() || matches!(second, '_' | '-')),
        Some(first) => first.is_alphabetic() || first == '_' || !first.is_ascii(),
        None => false,
    };
    starts_well
        && text.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_') || !c.is_ascii())
        && !is_wide_keyword(text)
        && !text.eq_ignore_ascii_case("default")
}

fn is_wide_keyword(text: &str) -> bool {
    ["initial", "inherit", "unset", "revert", "revert-layer"].iter().any(|keyword| text.eq_ignore_ascii_case(keyword))
}

impl Component {
    fn matches(&self, value: &str) -> bool {
        match self.multiplier {
            Multiplier::One => self.kind.matches(value),
            Multiplier::Spaces => {
                let parts = split_spaces(value);
                !parts.is_empty() && parts.iter().all(|part| self.kind.matches(part))
            }
            Multiplier::Commas => {
                let parts = split_commas(value);
                parts.iter().all(|part| self.kind.matches(part.trim()))
            }
        }
    }
}

/// `value` cut at the whitespace outside parentheses, strings and `url()`.
fn split_spaces(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut start: Option<usize> = None;
    for (index, character) in value.char_indices() {
        if let Some(open) = quote {
            if character == open {
                quote = None;
            }
            continue;
        }
        match character {
            '"' | '\'' => {
                quote = Some(character);
                start.get_or_insert(index);
            }
            '(' => {
                depth += 1;
                start.get_or_insert(index);
            }
            ')' => depth = depth.saturating_sub(1),
            c if c.is_ascii_whitespace() && depth == 0 => {
                if let Some(from) = start.take() {
                    parts.push(&value[from..index]);
                }
            }
            _ => {
                start.get_or_insert(index);
            }
        }
    }
    if let Some(from) = start {
        parts.push(&value[from..]);
    }
    parts
}

const LENGTH_UNITS: &[&str] = &[
    "px", "cm", "mm", "q", "in", "pt", "pc", "em", "ex", "ch", "rem", "cap", "ic", "lh", "rlh", "vw", "vh", "vmin", "vmax", "vi", "vb",
    "svw", "svh", "lvw", "lvh", "dvw", "dvh", "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax",
];

/// A number, then what follows it, or `None` when `text` does not start with a number.
fn split_number(text: &str) -> Option<(f64, &str)> {
    let bytes = text.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end += 1;
    }
    let digits_from = end;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    if bytes.get(end) == Some(&b'.') && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
        end += 1;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
    }
    if end == digits_from {
        return None;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let mut exponent = end + 1;
        if matches!(bytes.get(exponent), Some(b'+' | b'-')) {
            exponent += 1;
        }
        if bytes.get(exponent).is_some_and(u8::is_ascii_digit) {
            while bytes.get(exponent).is_some_and(u8::is_ascii_digit) {
                exponent += 1;
            }
            end = exponent;
        }
    }
    let number = text[..end].parse::<f64>().ok().filter(|number| number.is_finite())?;
    Some((number, &text[end..]))
}

/// A number with a unit of `units`, or with the `%` sign when `percent`.
fn is_dimension(text: &str, units: &[&str]) -> bool {
    split_number(text).is_some_and(|(_, unit)| units.iter().any(|known| unit.eq_ignore_ascii_case(known)))
}

fn is_math_function(text: &str) -> bool {
    ["calc", "min", "max", "clamp"].iter().any(|name| function_args(text, name).is_some())
}

impl Kind {
    fn matches(&self, value: &str) -> bool {
        match self {
            Kind::Ident(keyword) => value == keyword,
            Kind::Number => split_number(value).is_some_and(|(_, rest)| rest.is_empty()) || is_math_function(value),
            Kind::Integer => {
                let text = value.strip_prefix(['+', '-']).unwrap_or(value);
                (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())) || is_math_function(value)
            }
            Kind::Percentage => value.strip_suffix('%').is_some_and(|number| split_number(number).is_some_and(|(_, rest)| rest.is_empty())) || is_math_function(value),
            Kind::Length => {
                split_number(value).is_some_and(|(number, rest)| (number == 0.0 && rest.is_empty()) || LENGTH_UNITS.iter().any(|unit| rest.eq_ignore_ascii_case(unit)))
                    || is_math_function(value)
            }
            Kind::LengthPercentage => Kind::Length.matches(value) || Kind::Percentage.matches(value),
            Kind::Angle => is_dimension(value, &["deg", "grad", "rad", "turn"]) || is_math_function(value),
            Kind::Time => is_dimension(value, &["s", "ms"]) || is_math_function(value),
            Kind::Resolution => is_dimension(value, &["dpi", "dpcm", "dppx", "x"]),
            Kind::Color => {
                !value.eq_ignore_ascii_case("currentcolor") && resolve_color(value, &ColorContext::root(Scheme::Light)).is_some()
            }
            Kind::Url => value.get(..4).is_some_and(|head| head.eq_ignore_ascii_case("url(")) && value.ends_with(')'),
            Kind::Image => {
                Kind::Url.matches(value)
                    || ["linear-gradient", "radial-gradient", "conic-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient", "image-set", "cross-fade", "image"]
                        .iter()
                        .any(|name| function_args(value, name).is_some())
            }
            Kind::TransformFunction => TRANSFORM_FUNCTIONS.iter().any(|name| function_args(value, name).is_some()),
            Kind::CustomIdent => is_ident(value),
        }
    }
}

const TRANSFORM_FUNCTIONS: &[&str] = &[
    "matrix", "matrix3d", "translate", "translatex", "translatey", "translatez", "translate3d", "scale", "scalex", "scaley", "scalez", "scale3d", "rotate",
    "rotatex", "rotatey", "rotatez", "rotate3d", "skew", "skewx", "skewy", "perspective",
];

/// Whether `text` needs nothing outside itself to compute: no `var()` or `env()`, no unit that is a
/// fraction of the font, and not `currentcolor` or a CSS-wide keyword. An initial value has to be.
fn is_computationally_independent(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("var(") || lower.contains("env(") || lower.contains("attr(") || lower.contains("currentcolor") || is_wide_keyword(lower.trim()) {
        return false;
    }
    const FONT_RELATIVE: &[&str] = &["em", "ex", "ch", "ic", "cap", "lh", "rem", "rlh", "rex", "rch", "ric", "rcap"];
    // A digit that continues a word (a hex colour, `a1`) starts no number.
    let in_word = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'#' | b'_');
    let bytes = lower.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if (bytes[at].is_ascii_digit() || bytes[at] == b'.') && (at == 0 || !in_word(bytes[at - 1])) {
            if let Some((_, after)) = split_number(&lower[at..]) {
                let unit_len = after.bytes().take_while(u8::is_ascii_alphabetic).count();
                if FONT_RELATIVE.contains(&&after[..unit_len]) {
                    return false;
                }
                at = lower.len() - after.len() + unit_len;
                continue;
            }
        }
        at += 1;
    }
    true
}

impl Registration {
    /// The registration `name`, `syntax`, `inherits` and `initial_value` make, or why it is not one:
    /// the rule is ignored when a descriptor is missing or invalid (CSS Properties and Values API,
    /// the `@property` rule).
    pub(crate) fn new(name: &str, syntax: Option<&str>, inherits: Option<&str>, initial_value: Option<&str>) -> Result<Registration, String> {
        if !is_name(name) {
            return Err(format!("`{name}` is not a custom property name"));
        }
        let syntax_text = syntax.ok_or("the syntax descriptor is missing")?;
        let syntax = Syntax::parse(syntax_text).ok_or_else(|| format!("`{syntax_text}` is not a syntax"))?;
        let inherits = match inherits.map(str::trim) {
            Some(word) if word.eq_ignore_ascii_case("true") => true,
            Some(word) if word.eq_ignore_ascii_case("false") => false,
            Some(word) => return Err(format!("`{word}` is not true or false")),
            None => return Err("the inherits descriptor is missing".to_owned()),
        };
        let initial = initial_value.map(normalise).filter(|text| !text.is_empty());
        match (&syntax, &initial) {
            (Syntax::Universal, None) => {}
            (_, None) => return Err("the initial-value descriptor is missing".to_owned()),
            (syntax, Some(initial)) => {
                if !is_computationally_independent(initial) {
                    return Err(format!("the initial value `{initial}` is not computationally independent"));
                }
                if !syntax.matches(initial) {
                    return Err(format!("the initial value `{initial}` does not match the syntax"));
                }
            }
        }
        Ok(Registration { name: name.to_owned(), syntax, inherits, initial })
    }
}

/// The registrations of a document, by name.
#[derive(Debug, Default)]
pub(crate) struct Registered {
    by_name: FxHashMap<String, Registration>,
    /// The names that do not inherit, in name order.
    non_inheriting: Vec<String>,
    /// A hash of every registration, for the keys that hold what an element inherits.
    fingerprint: u64,
}

impl Registered {
    /// `None` when there is nothing to register. A name listed twice has its last registration.
    pub(crate) fn new(registrations: Vec<Registration>) -> Option<Registered> {
        if registrations.is_empty() {
            return None;
        }
        let mut by_name = FxHashMap::default();
        for registration in registrations {
            by_name.insert(registration.name.clone(), registration);
        }
        let mut names: Vec<&String> = by_name.keys().collect();
        names.sort();
        let mut fingerprint = crate::retain::Fingerprint::new();
        let mut non_inheriting = Vec::new();
        for name in names {
            let registration = &by_name[name];
            fingerprint.str(name);
            fingerprint.str(registration.initial.as_deref().unwrap_or(""));
            fingerprint.bits(&[registration.inherits, registration.initial.is_some()]);
            if !registration.inherits {
                non_inheriting.push(name.clone());
            }
        }
        Some(Registered { by_name, non_inheriting, fingerprint: fingerprint.finish() })
    }

    pub(crate) fn get(&self, name: &str) -> Option<&Registration> {
        self.by_name.get(name)
    }

    /// The initial value of `name`, when it is registered and has one.
    pub(crate) fn initial_of(&self, name: &str) -> Option<&str> {
        self.by_name.get(name).and_then(|registration| registration.initial.as_deref())
    }

    /// Every registered name with an initial value, with the value.
    pub(crate) fn initial_values(&self) -> impl Iterator<Item = (&str, &str)> {
        self.by_name.values().filter_map(|registration| Some((registration.name.as_str(), registration.initial.as_deref()?)))
    }

    pub(crate) fn non_inheriting(&self) -> &[String] {
        &self.non_inheriting
    }

    pub(crate) fn fingerprint(&self) -> u64 {
        self.fingerprint
    }
}

impl PartialEq for Registered {
    fn eq(&self, other: &Self) -> bool {
        self.fingerprint == other.fingerprint && self.by_name == other.by_name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(syntax: &str, inherits: &str, initial: Option<&str>) -> Result<Registration, String> {
        Registration::new("--p", Some(syntax), Some(inherits), initial)
    }

    #[test]
    fn a_syntax_is_a_star_or_a_list_of_components() {
        assert_eq!(Syntax::parse("*"), Some(Syntax::Universal));
        assert_eq!(Syntax::parse(" * "), Some(Syntax::Universal));
        let list = Syntax::parse("<length> | <percentage>+ | auto | <color>#").unwrap();
        let Syntax::Alternatives(list) = list else { panic!("a list") };
        assert_eq!(list.len(), 4);
        assert_eq!(list[1], Component { kind: Kind::Percentage, multiplier: Multiplier::Spaces });
        assert_eq!(list[2], Component { kind: Kind::Ident("auto".into()), multiplier: Multiplier::One });
        assert_eq!(list[3], Component { kind: Kind::Color, multiplier: Multiplier::Commas });
        assert_eq!(
            Syntax::parse("<transform-list>"),
            Some(Syntax::Alternatives(vec![Component { kind: Kind::TransformFunction, multiplier: Multiplier::Spaces }]))
        );
        for bad in ["", "<bogus>", "<length>++", "<length> |", "* | <length>", "<transform-list>#", "initial", "<length> <length>", "<string>"] {
            assert_eq!(Syntax::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_value_is_matched_against_the_grammar() {
        let matches = |syntax: &str, value: &str| Syntax::parse(syntax).unwrap().matches(value);
        assert!(matches("<length>", "10px"));
        assert!(matches("<length>", "0"));
        assert!(!matches("<length>", "10"));
        assert!(!matches("<length>", "10px 4px"));
        assert!(matches("<length>+", "10px 4px"));
        assert!(matches("<length>#", "10px, 4px"));
        assert!(matches("<length-percentage>", "50%"));
        assert!(matches("<number>", "1.5"));
        assert!(!matches("<number>", "1.5px"));
        assert!(matches("<integer>", "-3"));
        assert!(!matches("<integer>", "1.5"));
        assert!(matches("<percentage>", "0%"));
        assert!(matches("<angle>", "45deg"));
        assert!(!matches("<angle>", "0"));
        assert!(matches("<time>", "200ms"));
        assert!(matches("<color>", "#0000"));
        assert!(matches("<color>", "rgb(1 2 3)"));
        assert!(matches("<color>", "red"));
        assert!(!matches("<color>", "10px"));
        assert!(matches("<url>", "url(a.png)"));
        assert!(matches("<image>", "linear-gradient(red, blue)"));
        assert!(matches("<transform-list>", "rotate(45deg) scale(2)"));
        assert!(!matches("<transform-list>", "rotate(45deg) wobble(2)"));
        assert!(matches("auto | <length>", "auto"));
        assert!(!matches("auto | <length>", "Auto"));
        assert!(matches("<custom-ident>", "foo"));
        assert!(!matches("<custom-ident>", "inherit"));
        assert!(matches("<length>", "calc(1px + 2px)"));
    }

    #[test]
    fn a_registration_needs_its_descriptors_and_an_initial_value_that_fits() {
        let universal = Registration::new("--tw-rotate-x", Some("*"), Some("false"), None).unwrap();
        assert_eq!(universal.initial, None);
        assert!(!universal.inherits);
        let shadow = Registration::new("--tw-shadow", Some("*"), Some("false"), Some("0 0 #0000")).unwrap();
        assert_eq!(shadow.initial.as_deref(), Some("0 0 #0000"));
        assert!(registration("<length>", "true", Some("0px")).is_ok());

        assert!(Registration::new("--p", None, Some("true"), None).is_err());
        assert!(Registration::new("--p", Some("*"), None, None).is_err());
        assert!(Registration::new("--p", Some("*"), Some("maybe"), None).is_err());
        assert!(Registration::new("p", Some("*"), Some("true"), None).is_err());
        assert!(registration("<length>", "true", None).is_err(), "typed syntax needs an initial value");
        assert!(registration("<length>", "true", Some("red")).is_err(), "the value has to fit");
        assert!(registration("<length>", "true", Some("2em")).is_err(), "relative to the font");
        assert!(registration("<length>", "true", Some("calc(1rem + 1px)")).is_err());
        assert!(registration("<color>", "true", Some("currentcolor")).is_err());
        assert!(registration("*", "true", Some("var(--x)")).is_err());
        assert!(registration("<length>", "true", Some("2vw")).is_ok());
        assert!(registration("*", "true", Some("#1em")).is_ok(), "a hex colour is no number");
    }

    #[test]
    fn the_registry_keeps_the_last_registration_of_a_name_and_lists_what_does_not_inherit() {
        let first = registration("*", "true", Some("1")).unwrap();
        let second = Registration { initial: Some("2".into()), inherits: false, ..first.clone() };
        let registered = Registered::new(vec![first, second]).unwrap();
        assert_eq!(registered.initial_of("--p"), Some("2"));
        assert_eq!(registered.non_inheriting(), ["--p"]);
        assert!(Registered::new(Vec::new()).is_none());
    }
}
