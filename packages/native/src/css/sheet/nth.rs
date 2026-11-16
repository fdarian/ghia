//! `An+B` (CSS Syntax 3, section 6) and the structural pseudo-classes that count with it.

use super::tokenizer::{Kind, Token};

/// The positions `a * n + b` names for `n = 0, 1, 2, ...`, counted from 1.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct AnPlusB {
    a: i64,
    b: i64,
}

impl AnPlusB {
    /// `0n+b`: the one position `b`, which is what `:first-child` is with `b` 1.
    pub const fn only(b: i64) -> AnPlusB {
        AnPlusB { a: 0, b }
    }

    /// Reads `odd`, `even`, `n`, `-n+3`, `2n + 1`, `+5` and the rest of the microsyntax from the
    /// tokens between the parentheses, `None` when they are not one. `src` is the text the tokens
    /// index, which holds the digits a number token does not carry.
    pub(super) fn parse(src: &str, tokens: &[Token]) -> Option<AnPlusB> {
        let mut parser = Reader { src, tokens, at: 0 };
        parser.skip_whitespace();
        let parsed = parser.an_plus_b()?;
        parser.skip_whitespace();
        (parser.at == tokens.len()).then_some(parsed)
    }

    /// Whether it names the one position 1, which `:first-child` and `:last-child` are.
    pub fn is_first_only(self) -> bool {
        self == AnPlusB::only(1)
    }

    pub fn matches(self, index: u32) -> bool {
        let difference = i64::from(index) - self.b;
        if self.a == 0 {
            return difference == 0;
        }
        difference % self.a == 0 && difference / self.a >= 0
    }
}

/// A selector that asks where an element stands among its parent's children.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Position {
    /// `:nth-child()`, `:nth-last-child()`, `:nth-of-type()`, `:nth-last-of-type()` and
    /// `:first-child`, `:last-child`, `:first-of-type`, `:last-of-type`, which are `0n+1` of them.
    Nth { of_type: bool, from_end: bool, an_b: AnPlusB },
    /// `:only-child` and `:only-of-type`.
    Only { of_type: bool },
    /// `:empty`: no element child and no text.
    Empty,
}

impl Position {
    pub fn first(of_type: bool) -> Position {
        Position::Nth { of_type, from_end: false, an_b: AnPlusB::only(1) }
    }

    pub fn last(of_type: bool) -> Position {
        Position::Nth { of_type, from_end: true, an_b: AnPlusB::only(1) }
    }
}

struct Reader<'a> {
    src: &'a str,
    tokens: &'a [Token],
    at: usize,
}

/// The sign and magnitude of an integer written as `[+-]?[0-9]+`, whole.
fn integer(text: &str) -> Option<i64> {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value = text.parse::<i64>().ok()?;
    Some(value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)))
}

/// An integer with no sign: `<signless-integer>`.
fn signless(text: &str) -> Option<i64> {
    if text.starts_with(['+', '-']) {
        return None;
    }
    integer(text)
}

impl Reader<'_> {
    fn text(&self, token: &Token) -> &str {
        &self.src[token.start..token.end]
    }

    fn skip_whitespace(&mut self) {
        while self.tokens.get(self.at).is_some_and(|token| token.kind == Kind::Whitespace) {
            self.at += 1;
        }
    }

    fn an_plus_b(&mut self) -> Option<AnPlusB> {
        let token = self.tokens.get(self.at)?;
        match &token.kind {
            Kind::Ident(name) => {
                let name = name.to_ascii_lowercase();
                if name == "even" || name == "odd" {
                    self.at += 1;
                    return Some(AnPlusB { a: 2, b: i64::from(name == "odd") });
                }
                self.at += 1;
                let (a, rest) = match name.strip_prefix('-') {
                    Some(rest) => (-1, rest),
                    None => (1, name.as_str()),
                };
                self.after_n(a, rest)
            }
            Kind::Delim('+') => {
                // `+n` is one unit: no whitespace between the sign and the ident.
                let Kind::Ident(name) = &self.tokens.get(self.at + 1)?.kind else {
                    return None;
                };
                let name = name.to_ascii_lowercase();
                if name.starts_with('-') {
                    return None;
                }
                self.at += 2;
                self.after_n(1, &name)
            }
            Kind::Number => {
                let value = integer(self.text(token))?;
                self.at += 1;
                Some(AnPlusB::only(value))
            }
            Kind::Dimension => {
                let text = self.text(token).to_ascii_lowercase();
                let unit_start = text.find(|c: char| c.is_ascii_alphabetic())?;
                let a = integer(&text[..unit_start])?;
                self.at += 1;
                self.after_n(a, &text[unit_start..])
            }
            _ => None,
        }
    }

    /// What follows the `n` of `an_b`: `unit` is what the token held from the `n` on (`n`, `n-` or
    /// `n-3`), and the `B` is in it, in the tokens after it, or absent.
    fn after_n(&mut self, a: i64, unit: &str) -> Option<AnPlusB> {
        let tail = unit.strip_prefix('n')?;
        if tail.is_empty() {
            return Some(AnPlusB { a, b: self.signed_b()? });
        }
        let digits = tail.strip_prefix('-')?;
        if digits.is_empty() {
            self.skip_whitespace();
            let number = self.tokens.get(self.at).filter(|token| token.kind == Kind::Number)?;
            let b = signless(self.text(number))?;
            self.at += 1;
            return Some(AnPlusB { a, b: -b });
        }
        let b = signless(digits)?;
        Some(AnPlusB { a, b: -b })
    }

    /// `[ ['+' | '-'] <signless-integer> ]?`, or a signed integer, or nothing at all.
    fn signed_b(&mut self) -> Option<i64> {
        let mark = self.at;
        self.skip_whitespace();
        let Some(token) = self.tokens.get(self.at) else {
            self.at = mark;
            return Some(0);
        };
        match &token.kind {
            Kind::Delim(sign @ ('+' | '-')) => {
                let negative = *sign == '-';
                self.at += 1;
                self.skip_whitespace();
                let number = self.tokens.get(self.at).filter(|token| token.kind == Kind::Number)?;
                let value = signless(self.text(number))?;
                self.at += 1;
                Some(if negative { -value } else { value })
            }
            Kind::Number => {
                let text = self.text(token);
                if !text.starts_with(['+', '-']) {
                    return None;
                }
                let value = integer(text)?;
                self.at += 1;
                Some(value)
            }
            _ => {
                self.at = mark;
                Some(0)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tokenizer::tokenize;
    use super::*;

    fn parse(text: &str) -> Option<AnPlusB> {
        AnPlusB::parse(text, &tokenize(text))
    }

    fn an_b(a: i64, b: i64) -> Option<AnPlusB> {
        Some(AnPlusB { a, b })
    }

    #[test]
    fn the_forms_of_the_microsyntax() {
        assert_eq!(parse("odd"), an_b(2, 1));
        assert_eq!(parse("even"), an_b(2, 0));
        assert_eq!(parse("ODD"), an_b(2, 1));
        assert_eq!(parse("n"), an_b(1, 0));
        assert_eq!(parse("N"), an_b(1, 0));
        assert_eq!(parse("-n"), an_b(-1, 0));
        assert_eq!(parse("+n"), an_b(1, 0));
        assert_eq!(parse("2n+1"), an_b(2, 1));
        assert_eq!(parse("2N+1"), an_b(2, 1));
        assert_eq!(parse("2n + 1"), an_b(2, 1));
        assert_eq!(parse("2n +1"), an_b(2, 1));
        assert_eq!(parse("2n+ 1"), an_b(2, 1));
        assert_eq!(parse("-n+3"), an_b(-1, 3));
        assert_eq!(parse("-n + 3"), an_b(-1, 3));
        assert_eq!(parse("+n+3"), an_b(1, 3));
        assert_eq!(parse("+5"), an_b(0, 5));
        assert_eq!(parse("5"), an_b(0, 5));
        assert_eq!(parse("-5"), an_b(0, -5));
        assert_eq!(parse("-2n-1"), an_b(-2, -1));
        assert_eq!(parse("2n- 1"), an_b(2, -1));
        assert_eq!(parse("2n - 1"), an_b(2, -1));
        assert_eq!(parse("2n -1"), an_b(2, -1));
        assert_eq!(parse("n-1"), an_b(1, -1));
        assert_eq!(parse("n- 1"), an_b(1, -1));
        assert_eq!(parse("-n-1"), an_b(-1, -1));
        assert_eq!(parse("3n"), an_b(3, 0));
        assert_eq!(parse("0n+0"), an_b(0, 0));
        assert_eq!(parse("  2n+1  "), an_b(2, 1));
        assert_eq!(parse("2n/**/+/**/1"), an_b(2, 1));
    }

    #[test]
    fn what_is_not_the_microsyntax() {
        for text in [
            "", "2 n", "+ 2n", "+ n", "n+", "n-", "2n+", "2n-", "1.5", "2.5n", "2.0n+1", "2n+1.5", "2n+-1", "2n+ -1", "2n--1",
            "2n+ +1", "n +", "- n", "n n", "2n 1", "2n+1 3", "even odd", "evenn", "n-x", "-n+", "2m+1", "1e1", "2e1n", "+-n", "++n",
            "2n+1n", "n,1", "n 1",
        ] {
            assert_eq!(parse(text), None, "{text:?}");
        }
    }

    #[test]
    fn positions_a_form_names() {
        let at = |text: &str| (1..=10).filter(|index| parse(text).unwrap().matches(*index)).collect::<Vec<_>>();
        assert_eq!(at("odd"), [1, 3, 5, 7, 9]);
        assert_eq!(at("even"), [2, 4, 6, 8, 10]);
        assert_eq!(at("n"), (1..=10).collect::<Vec<_>>());
        assert_eq!(at("3"), [3]);
        assert_eq!(at("0n+0"), Vec::<u32>::new());
        assert_eq!(at("-n+3"), [1, 2, 3]);
        assert_eq!(at("n+4"), [4, 5, 6, 7, 8, 9, 10]);
        assert_eq!(at("3n"), [3, 6, 9]);
        assert_eq!(at("3n+2"), [2, 5, 8]);
        assert_eq!(at("-2n+7"), [1, 3, 5, 7]);
        assert_eq!(at("-n-1"), Vec::<u32>::new());
        assert_eq!(at("2n-1"), [1, 3, 5, 7, 9]);
        assert_eq!(at("-3"), Vec::<u32>::new());
    }

    #[test]
    fn a_huge_number_is_clamped_not_wrapped() {
        assert_eq!(parse("99999999999n"), an_b(i64::from(i32::MAX), 0));
        assert_eq!(parse("99999999999999999999n"), None);
        assert!(!parse("2147483647").unwrap().matches(u32::MAX));
    }
}
