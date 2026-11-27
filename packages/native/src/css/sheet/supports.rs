//! `@supports` conditions, decided when the sheet is parsed.
//!
//! `(property: value)` is true when a declaration of it would be kept: the check every
//! declaration of a sheet goes through (`Validator`). `selector(...)` is true when the selector
//! parses, `font-tech()` and `font-format()` when this engine loads such a font. `not`, `and` and `or`
//! combine them, and a group in parentheses nests. A `<general-enclosed>` block (one that is neither a
//! known feature nor a condition) is false without being an error, so `not` of it holds. A condition
//! that does not parse (a missing operand, `and` mixed with `or`, a bare word) is false, and so is
//! everything it is combined with: `None` here, which the caller drops the block for.

use super::atoms::Atoms;
use super::declarations::parse_declaration;
use super::font_face;
use super::selector_parse::{parse_selector_list, Nesting};
use super::tokenizer::{find_close, trim, Kind, Token};
use super::validate::Validator;

/// Whether the prelude of an `@supports` holds, `None` when it is not a valid condition.
pub(super) fn evaluate(src: &str, prelude: &[Token], validator: &mut Validator) -> Option<bool> {
    let mut condition = Condition { src, tokens: trim(prelude), position: 0, validator };
    let result = condition.condition()?;
    condition.skip_whitespace();
    (condition.position == condition.tokens.len()).then_some(result)
}

struct Condition<'a, 'v> {
    src: &'a str,
    tokens: &'a [Token],
    position: usize,
    validator: &'v mut Validator,
}

impl Condition<'_, '_> {
    fn skip_whitespace(&mut self) {
        while self.tokens.get(self.position).is_some_and(|token| token.kind == Kind::Whitespace) {
            self.position += 1;
        }
    }

    fn peek_word(&mut self) -> Option<String> {
        self.skip_whitespace();
        match &self.tokens.get(self.position)?.kind {
            Kind::Ident(word) => Some(word.to_ascii_lowercase()),
            _ => None,
        }
    }

    fn condition(&mut self) -> Option<bool> {
        if self.peek_word().as_deref() == Some("not") {
            self.position += 1;
            return Some(!self.in_parens()?);
        }
        let mut result = self.in_parens()?;
        let mut operator: Option<String> = None;
        while let Some(word) = self.peek_word() {
            if !matches!(word.as_str(), "and" | "or") || operator.as_ref().is_some_and(|held| *held != word) {
                return None;
            }
            self.position += 1;
            let next = self.in_parens()?;
            result = if word == "and" { result && next } else { result || next };
            operator = Some(word);
        }
        Some(result)
    }

    /// `( <condition> )`, `( <declaration> )`, `selector( <selector> )`, `font-tech( )`, `font-format( )`, or
    /// `<general-enclosed>`: any other block or function, which is false and not an error, so that a condition
    /// of a later spec does not drop the rule it guards in an engine that reads the rest.
    fn in_parens(&mut self) -> Option<bool> {
        self.skip_whitespace();
        let open = self.position;
        let kind = &self.tokens.get(open)?.kind;
        let function = match kind {
            Kind::OpenParen => None,
            Kind::Function(name) => Some(name.to_ascii_lowercase()),
            _ => return None,
        };
        let close = find_close(self.tokens, open);
        if close >= self.tokens.len() {
            return None;
        }
        self.position = close + 1;
        let inner = trim(&self.tokens[open + 1..close]);
        if let Some(name) = function {
            return Some(match name.as_str() {
                "selector" => {
                    let parsed = parse_selector_list(self.src, inner, &mut Atoms::default(), Nesting::Top);
                    matches!(parsed, Ok(list) if list.len() == 1)
                }
                "font-tech" => Self::names_one_of(inner, &font_face::SUPPORTED_TECHS),
                "font-format" => Self::names_one_of(inner, &font_face::SUPPORTED_FORMATS),
                _ => false,
            });
        }
        let nested = match inner.first().map(|token| &token.kind) {
            Some(Kind::OpenParen | Kind::Function(_)) => true,
            Some(Kind::Ident(word)) => word.eq_ignore_ascii_case("not"),
            _ => false,
        };
        if nested {
            if let Some(result) = evaluate(self.src, inner, self.validator) {
                return Some(result);
            }
        }
        Some(parse_declaration(self.src, inner).is_some_and(|parsed| self.validator.supports(&parsed.declaration)))
    }

    /// Whether `argument` is one identifier or string that is one of `known`.
    fn names_one_of(argument: &[Token], known: &[&str]) -> bool {
        match argument {
            [token] => match &token.kind {
                Kind::Ident(word) | Kind::Str(word) => known.iter().any(|known| known.eq_ignore_ascii_case(word)),
                _ => false,
            },
            _ => false,
        }
    }
}
