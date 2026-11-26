//! Media Queries Level 4: the parser and evaluator behind a stylesheet's `@media`.
//!
//! The grammar and the feature set are those of `js/media-query.ts`, which `matchMedia` runs: a
//! query list item that does not parse, or that names a feature or a value this engine does not
//! know, is `not all` (it never matches), as in browsers, and the other items of its comma list
//! still count. `resolution` is the one feature added here, since a window's scale factor is at
//! hand natively. The serializer is not ported: nothing here reports `media` text back.
//!
//! Pure: no window, no sheet. [`MediaEnvironment`] holds what a query reads of the window.

use crate::color::Scheme;

/// What the media features of a window read.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct MediaEnvironment {
    /// The content size of the window in CSS pixels, as `getWindowSize` reports it.
    pub width: f64,
    pub height: f64,
    /// Device pixels per CSS pixel.
    pub scale_factor: f64,
    pub color_scheme: Scheme,
    pub reduced_motion: bool,
    pub increased_contrast: bool,
    pub forced_colors: bool,
}

/// A comma-separated media query list: it matches when any item does, and the empty list matches.
#[derive(Debug)]
pub(crate) struct MediaQueryList {
    text: String,
    items: Vec<Item>,
}

impl MediaQueryList {
    pub(crate) fn parse(text: &str) -> MediaQueryList {
        let tokens = tokenize(text);
        let items = if tokens.is_empty() { Vec::new() } else { split_top_level(&tokens).into_iter().map(compile_item).collect() };
        MediaQueryList { text: text.split_ascii_whitespace().collect::<Vec<_>>().join(" "), items }
    }

    /// The source text with its whitespace collapsed: two lists with the same text are the same query.
    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    pub(crate) fn matches(&self, environment: &MediaEnvironment) -> bool {
        self.items.is_empty() || self.items.iter().any(|item| item.matches(environment))
    }
}

#[derive(Debug)]
enum Item {
    /// `not all`: a syntax error, or a feature or value that is not known.
    Never,
    Query { negate: bool, type_matches: bool, condition: Option<Condition> },
}

impl Item {
    fn matches(&self, environment: &MediaEnvironment) -> bool {
        match self {
            Item::Never => false,
            Item::Query { negate, type_matches, condition } => {
                let result = *type_matches && condition.as_ref().is_none_or(|condition| condition.evaluate(environment));
                result != *negate
            }
        }
    }
}

// Features.

#[derive(Debug, Clone, Copy, PartialEq)]
enum Feature {
    Width,
    Height,
    AspectRatio,
    Resolution,
    Color,
    Monochrome,
    Orientation,
    PrefersColorScheme,
    PrefersReducedMotion,
    PrefersContrast,
    ForcedColors,
    Hover,
    AnyHover,
    Pointer,
    AnyPointer,
}

enum Kind {
    Length,
    Ratio,
    Resolution,
    Integer,
    Discrete {
        values: &'static [&'static str],
        /// The value `(feature)` in a boolean context treats as false.
        falsy: Option<&'static str>,
    },
}

const HOVER: Kind = Kind::Discrete { values: &["none", "hover"], falsy: Some("none") };
const POINTER: Kind = Kind::Discrete { values: &["none", "coarse", "fine"], falsy: Some("none") };

impl Feature {
    fn named(name: &str) -> Option<Feature> {
        Some(match name {
            "width" => Feature::Width,
            "height" => Feature::Height,
            "aspect-ratio" => Feature::AspectRatio,
            "resolution" => Feature::Resolution,
            "color" => Feature::Color,
            "monochrome" => Feature::Monochrome,
            "orientation" => Feature::Orientation,
            "prefers-color-scheme" => Feature::PrefersColorScheme,
            "prefers-reduced-motion" => Feature::PrefersReducedMotion,
            "prefers-contrast" => Feature::PrefersContrast,
            "forced-colors" => Feature::ForcedColors,
            "hover" => Feature::Hover,
            "any-hover" => Feature::AnyHover,
            "pointer" => Feature::Pointer,
            "any-pointer" => Feature::AnyPointer,
            _ => return None,
        })
    }

    fn kind(self) -> Kind {
        match self {
            Feature::Width | Feature::Height => Kind::Length,
            Feature::AspectRatio => Kind::Ratio,
            Feature::Resolution => Kind::Resolution,
            Feature::Color | Feature::Monochrome => Kind::Integer,
            Feature::Orientation => Kind::Discrete { values: &["portrait", "landscape"], falsy: None },
            Feature::PrefersColorScheme => Kind::Discrete { values: &["light", "dark"], falsy: None },
            Feature::PrefersReducedMotion => Kind::Discrete { values: &["no-preference", "reduce"], falsy: Some("no-preference") },
            Feature::PrefersContrast => {
                Kind::Discrete { values: &["no-preference", "more", "less", "custom"], falsy: Some("no-preference") }
            }
            Feature::ForcedColors => Kind::Discrete { values: &["none", "active"], falsy: Some("none") },
            Feature::Hover | Feature::AnyHover => HOVER,
            Feature::Pointer | Feature::AnyPointer => POINTER,
        }
    }

    /// The value of a numeric feature: pixels, a ratio, device pixels per pixel, or a count.
    fn number(self, environment: &MediaEnvironment) -> f64 {
        match self {
            Feature::Width => environment.width,
            Feature::Height => environment.height,
            Feature::AspectRatio => environment.width / environment.height,
            Feature::Resolution => environment.scale_factor,
            Feature::Color => 8.0,
            Feature::Monochrome => 0.0,
            _ => unreachable!("a discrete feature has no number"),
        }
    }

    /// The keyword of a discrete feature. There is no touch input or hover-less pointer on the
    /// platforms Ghia targets.
    fn keyword(self, environment: &MediaEnvironment) -> &'static str {
        match self {
            Feature::Orientation if environment.height >= environment.width => "portrait",
            Feature::Orientation => "landscape",
            Feature::PrefersColorScheme if environment.color_scheme == Scheme::Dark => "dark",
            Feature::PrefersColorScheme => "light",
            Feature::PrefersReducedMotion if environment.reduced_motion => "reduce",
            Feature::PrefersReducedMotion => "no-preference",
            Feature::PrefersContrast if environment.increased_contrast => "more",
            Feature::PrefersContrast => "no-preference",
            Feature::ForcedColors if environment.forced_colors => "active",
            Feature::ForcedColors => "none",
            Feature::Hover | Feature::AnyHover => "hover",
            Feature::Pointer | Feature::AnyPointer => "fine",
            _ => unreachable!("a numeric feature has no keyword"),
        }
    }
}

// Values and conditions.

#[derive(Debug, Clone, Copy, PartialEq)]
enum Compare {
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
    Equal,
}

impl Compare {
    fn holds(self, left: f64, right: f64) -> bool {
        match self {
            Compare::Less => left < right,
            Compare::LessOrEqual => left <= right,
            Compare::Greater => left > right,
            Compare::GreaterOrEqual => left >= right,
            Compare::Equal => left == right,
        }
    }

    fn flipped(self) -> Compare {
        match self {
            Compare::Less => Compare::Greater,
            Compare::LessOrEqual => Compare::GreaterOrEqual,
            Compare::Greater => Compare::Less,
            Compare::GreaterOrEqual => Compare::LessOrEqual,
            Compare::Equal => Compare::Equal,
        }
    }

    fn is_less(self) -> bool {
        matches!(self, Compare::Less | Compare::LessOrEqual)
    }

    fn is_greater(self) -> bool {
        matches!(self, Compare::Greater | Compare::GreaterOrEqual)
    }
}

/// Media queries resolve `em` and `rem` against the initial font size.
const INITIAL_FONT_SIZE: f64 = 16.0;

#[derive(Debug, Clone, Copy, PartialEq)]
enum LengthUnit {
    /// Pixels per unit.
    Fixed(f64),
    Vw,
    Vh,
    Vmin,
    Vmax,
}

impl LengthUnit {
    fn named(unit: &str) -> Option<LengthUnit> {
        Some(match unit {
            "px" => LengthUnit::Fixed(1.0),
            "em" | "rem" => LengthUnit::Fixed(INITIAL_FONT_SIZE),
            "pt" => LengthUnit::Fixed(96.0 / 72.0),
            "pc" => LengthUnit::Fixed(16.0),
            "in" => LengthUnit::Fixed(96.0),
            "cm" => LengthUnit::Fixed(96.0 / 2.54),
            "mm" => LengthUnit::Fixed(96.0 / 25.4),
            "q" => LengthUnit::Fixed(96.0 / 101.6),
            "vw" => LengthUnit::Vw,
            "vh" => LengthUnit::Vh,
            "vmin" => LengthUnit::Vmin,
            "vmax" => LengthUnit::Vmax,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Value {
    Number(f64),
    Length { amount: f64, unit: LengthUnit },
    Ratio(f64),
    /// In device pixels per CSS pixel.
    Resolution(f64),
    Ident(String),
}

impl Value {
    fn number(&self, environment: &MediaEnvironment) -> f64 {
        match self {
            Value::Number(value) | Value::Ratio(value) | Value::Resolution(value) => *value,
            Value::Length { amount, unit } => match unit {
                LengthUnit::Fixed(factor) => amount * factor,
                LengthUnit::Vw => amount * environment.width / 100.0,
                LengthUnit::Vh => amount * environment.height / 100.0,
                LengthUnit::Vmin => amount * environment.width.min(environment.height) / 100.0,
                LengthUnit::Vmax => amount * environment.width.max(environment.height) / 100.0,
            },
            Value::Ident(_) => unreachable!("validated as numeric"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Prefix {
    Min,
    Max,
}

#[derive(Debug)]
enum Condition {
    Boolean(Feature),
    Plain { feature: Feature, prefix: Option<Prefix>, value: Value },
    Range {
        feature: Feature,
        /// `value op feature`.
        left: Option<(Compare, Value)>,
        /// `feature op value`.
        right: Option<(Compare, Value)>,
    },
    Not(Box<Condition>),
    And(Vec<Condition>),
    Or(Vec<Condition>),
}

impl Condition {
    fn evaluate(&self, environment: &MediaEnvironment) -> bool {
        match self {
            Condition::Not(child) => !child.evaluate(environment),
            Condition::And(children) => children.iter().all(|child| child.evaluate(environment)),
            Condition::Or(children) => children.iter().any(|child| child.evaluate(environment)),
            Condition::Boolean(feature) => match feature.kind() {
                Kind::Discrete { falsy, .. } => Some(feature.keyword(environment)) != falsy,
                _ => feature.number(environment) != 0.0,
            },
            Condition::Plain { feature, prefix, value } => {
                if matches!(feature.kind(), Kind::Discrete { .. }) {
                    return matches!(value, Value::Ident(word) if word == feature.keyword(environment));
                }
                let actual = feature.number(environment);
                let wanted = value.number(environment);
                match prefix {
                    Some(Prefix::Min) => actual >= wanted,
                    Some(Prefix::Max) => actual <= wanted,
                    None => actual == wanted,
                }
            }
            Condition::Range { feature, left, right } => {
                let actual = feature.number(environment);
                // `400px <= width` reads as `width >= 400px`.
                if let Some((op, value)) = left {
                    if !op.flipped().holds(actual, value.number(environment)) {
                        return false;
                    }
                }
                if let Some((op, value)) = right {
                    if !op.holds(actual, value.number(environment)) {
                        return false;
                    }
                }
                true
            }
        }
    }
}

// Tokens.

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Number { value: f64, unit: String },
    Open,
    Close,
    Comma,
    Colon,
    Slash,
    Compare(Compare),
    Error,
}

#[derive(Debug, Clone)]
struct Token {
    tok: Tok,
    space_before: bool,
}

/// The end of the number that starts at `at`: a sign, digits with an optional fraction or a
/// fraction alone, and an exponent that has digits.
fn scan_number(chars: &[char], at: usize) -> Option<usize> {
    let digits = |from: usize| chars[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut index = at;
    if matches!(chars.get(index), Some('+' | '-')) {
        index += 1;
    }
    let whole = digits(index);
    if whole > 0 {
        index += whole;
        if chars.get(index) == Some(&'.') {
            index += 1 + digits(index + 1);
        }
    } else if chars.get(index) == Some(&'.') && digits(index + 1) > 0 {
        index += 1 + digits(index + 1);
    } else {
        return None;
    }
    if matches!(chars.get(index), Some('e' | 'E')) {
        let mut exponent = index + 1;
        if matches!(chars.get(exponent), Some('+' | '-')) {
            exponent += 1;
        }
        let exponent_digits = digits(exponent);
        if exponent_digits > 0 {
            index = exponent + exponent_digits;
        }
    }
    Some(index)
}

/// The end of the identifier that starts at `at`: up to two dashes, a letter or `_`, then name characters.
fn scan_ident(chars: &[char], at: usize) -> Option<usize> {
    let mut index = at;
    while index < at + 2 && chars.get(index) == Some(&'-') {
        index += 1;
    }
    if !chars.get(index).is_some_and(|c| c.is_ascii_alphabetic() || *c == '_') {
        return None;
    }
    index += chars[index..].iter().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')).count();
    Some(index)
}

fn tokenize(text: &str) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0;
    let mut space_before = false;
    while index < chars.len() {
        let c = chars[index];
        if c.is_whitespace() {
            space_before = true;
            index += 1;
            continue;
        }
        if c == '/' && chars.get(index + 1) == Some(&'*') {
            space_before = true;
            let close = chars[index + 2..].windows(2).position(|pair| pair == ['*', '/']);
            index = close.map_or(chars.len(), |close| index + 2 + close + 2);
            continue;
        }
        let space = std::mem::take(&mut space_before);
        let next = chars.get(index + 1);
        let (tok, length) = match c {
            '(' => (Tok::Open, 1),
            ')' => (Tok::Close, 1),
            ',' => (Tok::Comma, 1),
            ':' => (Tok::Colon, 1),
            '/' => (Tok::Slash, 1),
            '<' if next == Some(&'=') => (Tok::Compare(Compare::LessOrEqual), 2),
            '<' => (Tok::Compare(Compare::Less), 1),
            '>' if next == Some(&'=') => (Tok::Compare(Compare::GreaterOrEqual), 2),
            '>' => (Tok::Compare(Compare::Greater), 1),
            '=' => (Tok::Compare(Compare::Equal), 1),
            _ => {
                if let Some(end) = scan_number(&chars, index) {
                    let value: f64 = chars[index..end].iter().collect::<String>().parse().expect("a scanned number parses");
                    let unit_length = chars[end..].iter().take_while(|c| c.is_ascii_alphabetic() || **c == '%').count();
                    let unit: String = chars[end..end + unit_length].iter().collect::<String>().to_ascii_lowercase();
                    (Tok::Number { value, unit }, end - index + unit_length)
                } else if let Some(end) = scan_ident(&chars, index) {
                    let word: String = chars[index..end].iter().collect::<String>().to_ascii_lowercase();
                    (Tok::Ident(word), end - index)
                } else {
                    (Tok::Error, 1)
                }
            }
        };
        tokens.push(Token { tok, space_before: space });
        index += length;
    }
    tokens
}

fn split_top_level(tokens: &[Token]) -> Vec<&[Token]> {
    let mut items = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (index, token) in tokens.iter().enumerate() {
        match token.tok {
            Tok::Open => depth += 1,
            Tok::Close => depth -= 1,
            Tok::Comma if depth == 0 => {
                items.push(&tokens[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    items.push(&tokens[start..]);
    items
}

// Parser.

/// A syntax error, or a feature or value that is not known.
struct Unsupported;

type Parse<T> = Result<T, Unsupported>;

#[derive(PartialEq)]
enum Qualifier {
    Not,
    Only,
}

struct ParsedItem {
    qualifier: Option<Qualifier>,
    media_type: Option<String>,
    condition: Option<Condition>,
}

struct Parser<'a> {
    tokens: &'a [Token],
    index: usize,
}

fn is_word(token: Option<&Token>, word: &str) -> bool {
    matches!(token, Some(Token { tok: Tok::Ident(found), .. }) if found == word)
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.index)
    }

    fn peek_at(&self, offset: usize) -> Option<&Token> {
        self.tokens.get(self.index + offset)
    }

    fn next(&mut self) -> Option<&Token> {
        let token = self.tokens.get(self.index);
        self.index += 1;
        token
    }

    fn expect_end(&self) -> Parse<()> {
        if self.index < self.tokens.len() {
            return Err(Unsupported);
        }
        Ok(())
    }

    /// Whether a condition starts here: `(`, or `not (`.
    fn at_condition(&self) -> bool {
        matches!(self.peek(), Some(Token { tok: Tok::Open, .. }))
            || (is_word(self.peek(), "not") && matches!(self.peek_at(1), Some(Token { tok: Tok::Open, .. })))
    }

    fn parse_item(&mut self) -> Parse<ParsedItem> {
        if self.at_condition() {
            let condition = self.parse_condition(true)?;
            self.expect_end()?;
            return Ok(ParsedItem { qualifier: None, media_type: None, condition: Some(condition) });
        }
        let qualifier = if is_word(self.peek(), "not") {
            Some(Qualifier::Not)
        } else if is_word(self.peek(), "only") {
            Some(Qualifier::Only)
        } else {
            None
        };
        if qualifier.is_some() {
            self.index += 1;
        }
        let media_type = match self.next() {
            Some(Token { tok: Tok::Ident(word), .. }) if !matches!(word.as_str(), "not" | "and" | "or" | "only" | "layer") => word.clone(),
            _ => return Err(Unsupported),
        };
        let mut condition = None;
        if self.peek().is_some() {
            if !is_word(self.peek(), "and") {
                return Err(Unsupported);
            }
            self.index += 1;
            condition = Some(self.parse_condition(false)?);
        }
        self.expect_end()?;
        Ok(ParsedItem { qualifier, media_type: Some(media_type), condition })
    }

    fn parse_condition(&mut self, allow_or: bool) -> Parse<Condition> {
        if is_word(self.peek(), "not") {
            self.index += 1;
            return Ok(Condition::Not(Box::new(self.parse_in_parens()?)));
        }
        let mut operands = vec![self.parse_in_parens()?];
        let operator = match self.peek() {
            Some(Token { tok: Tok::Ident(word), .. }) if word == "and" || word == "or" => word.clone(),
            _ => return Ok(operands.remove(0)),
        };
        if operator == "or" && !allow_or {
            return Err(Unsupported);
        }
        while let Some(Token { tok: Tok::Ident(word), .. }) = self.peek() {
            if *word != operator {
                return Err(Unsupported);
            }
            self.index += 1;
            operands.push(self.parse_in_parens()?);
        }
        Ok(if operator == "and" { Condition::And(operands) } else { Condition::Or(operands) })
    }

    fn parse_in_parens(&mut self) -> Parse<Condition> {
        if !matches!(self.next(), Some(Token { tok: Tok::Open, .. })) {
            return Err(Unsupported);
        }
        let result = if self.at_condition() { self.parse_condition(true)? } else { self.parse_feature()? };
        if !matches!(self.next(), Some(Token { tok: Tok::Close, .. })) {
            return Err(Unsupported);
        }
        Ok(result)
    }

    fn comparison(&self) -> Option<Compare> {
        match self.peek() {
            Some(Token { tok: Tok::Compare(op), .. }) => Some(*op),
            _ => None,
        }
    }

    fn parse_feature(&mut self) -> Parse<Condition> {
        match self.next().map(|token| token.tok.clone()) {
            Some(Tok::Ident(name)) => match self.peek().map(|token| token.tok.clone()) {
                Some(Tok::Close) => Ok(Condition::Boolean(Feature::named(&name).ok_or(Unsupported)?)),
                Some(Tok::Colon) => {
                    self.index += 1;
                    let value = self.parse_value()?;
                    plain_feature(&name, value)
                }
                Some(Tok::Compare(op)) => {
                    self.index += 1;
                    let value = self.parse_value()?;
                    if self.comparison().is_some() {
                        return Err(Unsupported);
                    }
                    range_feature(&name, None, Some((op, value)))
                }
                _ => Err(Unsupported),
            },
            Some(Tok::Number { .. }) => {
                self.index -= 1;
                let left_value = self.parse_value()?;
                let Some(left_op) = self.comparison() else {
                    return Err(Unsupported);
                };
                self.index += 1;
                let name = match self.next() {
                    Some(Token { tok: Tok::Ident(name), .. }) => name.clone(),
                    _ => return Err(Unsupported),
                };
                let left = (left_op, left_value);
                let Some(right_op) = self.comparison() else {
                    return range_feature(&name, Some(left), None);
                };
                self.index += 1;
                let right = (right_op, self.parse_value()?);
                let same_direction = (left.0.is_less() && right.0.is_less()) || (left.0.is_greater() && right.0.is_greater());
                if !same_direction {
                    return Err(Unsupported);
                }
                range_feature(&name, Some(left), Some(right))
            }
            _ => Err(Unsupported),
        }
    }

    fn parse_value(&mut self) -> Parse<Value> {
        let (value, unit) = match self.next().map(|token| token.tok.clone()) {
            Some(Tok::Ident(word)) => return Ok(Value::Ident(word)),
            Some(Tok::Number { value, unit }) => (value, unit),
            _ => return Err(Unsupported),
        };
        if matches!(self.peek(), Some(Token { tok: Tok::Slash, .. })) {
            self.index += 1;
            return match self.next() {
                Some(Token { tok: Tok::Number { value: denominator, unit: denominator_unit }, .. })
                    if unit.is_empty() && denominator_unit.is_empty() =>
                {
                    Ok(Value::Ratio(value / denominator))
                }
                _ => Err(Unsupported),
            };
        }
        if unit.is_empty() {
            return Ok(Value::Number(value));
        }
        if let Some(per_pixel) = resolution_unit(&unit) {
            return Ok(Value::Resolution(value * per_pixel));
        }
        Ok(Value::Length { amount: value, unit: LengthUnit::named(&unit).ok_or(Unsupported)? })
    }
}

/// Device pixels per CSS pixel in one unit of `<resolution>`.
fn resolution_unit(unit: &str) -> Option<f64> {
    Some(match unit {
        "dppx" | "x" => 1.0,
        "dpi" => 1.0 / 96.0,
        "dpcm" => 2.54 / 96.0,
        _ => return None,
    })
}

fn plain_feature(name: &str, value: Value) -> Parse<Condition> {
    let (prefix, name) = match (name.strip_prefix("min-"), name.strip_prefix("max-")) {
        (Some(rest), _) => (Some(Prefix::Min), rest),
        (_, Some(rest)) => (Some(Prefix::Max), rest),
        _ => (None, name),
    };
    let feature = Feature::named(name).ok_or(Unsupported)?;
    if let Kind::Discrete { values, .. } = feature.kind() {
        let Value::Ident(word) = &value else {
            return Err(Unsupported);
        };
        if prefix.is_some() || !values.contains(&word.as_str()) {
            return Err(Unsupported);
        }
        return Ok(Condition::Plain { feature, prefix, value });
    }
    check_range_value(&feature.kind(), &value)?;
    Ok(Condition::Plain { feature, prefix, value })
}

fn range_feature(name: &str, left: Option<(Compare, Value)>, right: Option<(Compare, Value)>) -> Parse<Condition> {
    let feature = Feature::named(name).ok_or(Unsupported)?;
    let kind = feature.kind();
    for (_, value) in left.iter().chain(right.iter()) {
        check_range_value(&kind, value)?;
    }
    Ok(Condition::Range { feature, left, right })
}

/// Whether a numeric feature can be compared with `value`.
fn check_range_value(kind: &Kind, value: &Value) -> Parse<()> {
    let fits = match kind {
        Kind::Length => matches!(value, Value::Length { .. }) || *value == Value::Number(0.0),
        Kind::Ratio => matches!(value, Value::Ratio(_) | Value::Number(_)),
        Kind::Resolution => matches!(value, Value::Resolution(_)),
        Kind::Integer => matches!(value, Value::Number(number) if number.fract() == 0.0),
        Kind::Discrete { .. } => false,
    };
    if fits {
        Ok(())
    } else {
        Err(Unsupported)
    }
}

fn compile_item(tokens: &[Token]) -> Item {
    if tokens.iter().any(|token| token.tok == Tok::Error) {
        return Item::Never;
    }
    // `and(` is a function token in CSS, not the keyword `and`.
    for pair in tokens.windows(2) {
        if matches!(&pair[0].tok, Tok::Ident(word) if matches!(word.as_str(), "and" | "or" | "not"))
            && pair[1].tok == Tok::Open
            && !pair[1].space_before
        {
            return Item::Never;
        }
    }
    let Ok(parsed) = (Parser { tokens, index: 0 }).parse_item() else {
        return Item::Never;
    };
    let type_matches = match parsed.media_type.as_deref() {
        None | Some("all" | "screen") => true,
        Some(_) => false,
    };
    Item::Query { negate: parsed.qualifier == Some(Qualifier::Not), type_matches, condition: parsed.condition }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(width: f64, height: f64) -> MediaEnvironment {
        MediaEnvironment {
            width,
            height,
            scale_factor: 2.0,
            color_scheme: Scheme::Light,
            reduced_motion: false,
            increased_contrast: false,
            forced_colors: false,
        }
    }

    fn matches(query: &str, environment: &MediaEnvironment) -> bool {
        MediaQueryList::parse(query).matches(environment)
    }

    #[test]
    fn size_features_with_min_max_and_exact_values() {
        let wide = environment(1000.0, 600.0);
        assert!(matches("(min-width: 1000px)", &wide));
        assert!(!matches("(min-width: 1001px)", &wide));
        assert!(matches("(max-width: 1000px)", &wide));
        assert!(!matches("(max-width: 999px)", &wide));
        assert!(matches("(width: 1000px)", &wide));
        assert!(matches("(min-height: 600px) and (max-height: 600px)", &wide));
        assert!(matches("(min-width: 62.5em)", &wide), "em is the initial 16px");
        assert!(matches("(min-width: 50vw)", &wide) && !matches("(min-width: 101vw)", &wide));
        assert!(matches("(min-width: 0)", &wide), "a bare zero is a length");
    }

    #[test]
    fn range_syntax_in_both_directions() {
        let size = environment(800.0, 600.0);
        assert!(matches("(width >= 800px)", &size));
        assert!(!matches("(width > 800px)", &size));
        assert!(matches("(400px <= width <= 800px)", &size));
        assert!(!matches("(400px < width < 800px)", &size));
        assert!(matches("(400px <= width)", &size));
        assert!(matches("(height = 600px)", &size));
        assert!(!matches("(400px < width > 100px)", &size), "mixed directions are invalid");
    }

    #[test]
    fn orientation_and_aspect_ratio() {
        assert!(matches("(orientation: landscape)", &environment(800.0, 600.0)));
        assert!(matches("(orientation: portrait)", &environment(600.0, 800.0)));
        assert!(matches("(orientation: portrait)", &environment(600.0, 600.0)), "square is portrait");
        assert!(matches("(aspect-ratio: 16/9)", &environment(1600.0, 900.0)));
        assert!(matches("(min-aspect-ratio: 4 / 3)", &environment(1600.0, 900.0)));
        assert!(!matches("(max-aspect-ratio: 1)", &environment(1600.0, 900.0)));
    }

    #[test]
    fn user_preference_features() {
        let mut dark = environment(800.0, 600.0);
        dark.color_scheme = Scheme::Dark;
        dark.reduced_motion = true;
        dark.increased_contrast = true;
        dark.forced_colors = true;
        let light = environment(800.0, 600.0);
        assert!(matches("(prefers-color-scheme: dark)", &dark) && !matches("(prefers-color-scheme: dark)", &light));
        assert!(matches("(prefers-color-scheme: light)", &light));
        assert!(matches("(prefers-reduced-motion: reduce)", &dark) && !matches("(prefers-reduced-motion: reduce)", &light));
        assert!(matches("(prefers-reduced-motion)", &dark) && !matches("(prefers-reduced-motion)", &light));
        assert!(matches("(prefers-contrast: more)", &dark) && matches("(prefers-contrast: no-preference)", &light));
        assert!(matches("(forced-colors: active)", &dark) && matches("(forced-colors: none)", &light));
    }

    #[test]
    fn fixed_features_describe_a_mouse_and_a_colour_screen() {
        let any = environment(800.0, 600.0);
        for query in ["(hover: hover)", "(any-hover: hover)", "(pointer: fine)", "(any-pointer: fine)", "(color)", "(min-color: 8)", "(monochrome: 0)"] {
            assert!(matches(query, &any), "{query}");
        }
        for query in ["(hover: none)", "(pointer: coarse)", "(monochrome)", "(min-monochrome: 1)"] {
            assert!(!matches(query, &any), "{query}");
        }
    }

    #[test]
    fn resolution_reads_the_scale_factor() {
        let retina = environment(800.0, 600.0);
        assert!(matches("(min-resolution: 2dppx)", &retina));
        assert!(matches("(min-resolution: 192dpi)", &retina));
        assert!(matches("(resolution: 2x)", &retina));
        assert!(!matches("(min-resolution: 3dppx)", &retina));
        assert!(!matches("(min-resolution: 2)", &retina), "a resolution needs a unit");
    }

    #[test]
    fn media_types_and_qualifiers() {
        let any = environment(800.0, 600.0);
        assert!(matches("all", &any) && matches("screen", &any) && matches("only screen", &any));
        assert!(!matches("print", &any) && !matches("speech", &any));
        assert!(matches("not print", &any) && !matches("not screen", &any));
        assert!(matches("screen and (min-width: 800px)", &any));
        assert!(!matches("print and (min-width: 800px)", &any));
        assert!(matches("not screen and (min-width: 900px)", &any), "not negates the whole query");
        assert!(matches("", &any), "the empty list matches");
    }

    #[test]
    fn conditions_with_not_and_or() {
        let size = environment(800.0, 600.0);
        assert!(matches("(min-width: 700px) and (max-width: 900px)", &size));
        assert!(!matches("(min-width: 700px) and (max-width: 799px)", &size));
        assert!(matches("(min-width: 900px) or (max-height: 600px)", &size));
        assert!(matches("not (min-width: 900px)", &size));
        assert!(matches("((min-width: 700px) and (max-width: 900px)) or (width: 1px)", &size));
        assert!(!matches("(min-width: 700px) and (max-width: 900px) or (width: 800px)", &size), "mixing and with or is invalid");
    }

    #[test]
    fn a_comma_list_matches_when_any_item_does() {
        let size = environment(800.0, 600.0);
        assert!(matches("print, (min-width: 800px)", &size));
        assert!(!matches("print, (min-width: 900px)", &size));
    }

    #[test]
    fn an_unknown_or_invalid_item_never_matches_and_leaves_the_others() {
        let size = environment(800.0, 600.0);
        for query in [
            "(bogus: 1)",
            "(bogus)",
            "(min-width: red)",
            "(min-width: 10)",
            "(orientation: sideways)",
            "(min-orientation: portrait)",
            "(min-width: 10px",
            "(min-width 10px)",
            "screen and",
            "screen (min-width: 1px)",
            "not (bogus)",
            "and(min-width: 1px)",
            "(min-color: 1.5)",
        ] {
            assert!(!matches(query, &size), "{query}");
        }
        assert!(matches("(bogus: 1), (min-width: 800px)", &size));
        assert!(matches("screen and (min-width: 800px), (bogus)", &size));
    }

    #[test]
    fn keywords_and_units_are_not_case_sensitive_and_comments_are_blanks() {
        let size = environment(800.0, 600.0);
        assert!(matches("SCREEN AND (MIN-WIDTH: 800PX)", &size));
        assert!(matches("(min-width:/* a */800px)", &size));
        assert!(matches("(min-width :\n 800px )", &size));
    }

    #[test]
    fn the_text_collapses_whitespace() {
        assert_eq!(MediaQueryList::parse("  (min-width:  1px)\n and  screen ").text(), "(min-width: 1px) and screen");
    }
}
