//! `@supports` conditions, decided when the sheet is parsed.
//!
//! `(property: value)` is true when a declaration of it would be kept: the check every
//! declaration of a sheet goes through (`Validator`). `selector(...)` is true when the selector
//! parses. `not`, `and` and `or` combine them, and a group in parentheses nests. A condition that
//! does not parse (a general-enclosed block, a missing operand, `and` mixed with `or`) is false,
//! and so is everything it is combined with: `None` here, which the caller drops the block for.

use super::atoms::Atoms;
use super::declarations::parse_declaration;
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

    /// `( <condition> )`, `( <declaration> )` or `selector( <selector> )`.
    fn in_parens(&mut self) -> Option<bool> {
        self.skip_whitespace();
        let open = self.position;
        let kind = &self.tokens.get(open)?.kind;
        let is_selector_function = matches!(kind, Kind::Function(name) if name.eq_ignore_ascii_case("selector"));
        if *kind != Kind::OpenParen && !is_selector_function {
            return None;
        }
        let close = find_close(self.tokens, open);
        if close >= self.tokens.len() {
            return None;
        }
        self.position = close + 1;
        let inner = trim(&self.tokens[open + 1..close]);
        if is_selector_function {
            let parsed = parse_selector_list(self.src, inner, &mut Atoms::default(), Nesting::Top);
            return Some(matches!(parsed, Ok(list) if list.len() == 1));
        }
        let nested = match inner.first().map(|token| &token.kind) {
            Some(Kind::OpenParen) => true,
            Some(Kind::Ident(word)) => word.eq_ignore_ascii_case("not"),
            _ => false,
        };
        if nested {
            return evaluate(self.src, inner, self.validator);
        }
        let parsed = parse_declaration(self.src, inner)?;
        Some(self.validator.supports(&parsed.declaration))
    }
}
