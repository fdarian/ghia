//! A declaration as the style prop would carry it: a camelCase key and a JSON value.

use crate::css::lenient::{json_string, object_text, Declaration, UNITLESS};

use super::tokenizer::{trim, Kind, Token};

/// A declaration parsed from tokens, and whether it was `!important`.
pub(super) struct Parsed {
    pub(super) declaration: Declaration,
    pub(super) important: bool,
}

/// `None` for a declaration without a colon or with an empty value, which CSS skips.
pub(super) fn parse_declaration(src: &str, tokens: &[Token]) -> Option<Parsed> {
    let tokens = trim(tokens);
    let name = match &tokens.first()?.kind {
        Kind::Ident(name) => name,
        _ => return None,
    };
    let mut index = 1;
    while tokens.get(index).is_some_and(|token| token.kind == Kind::Whitespace) {
        index += 1;
    }
    if tokens.get(index)?.kind != Kind::Colon {
        return None;
    }
    let (value, important) = strip_important(trim(&tokens[index + 1..]));
    if value.is_empty() || value.iter().any(|token| token.kind == Kind::BadStr) {
        return None;
    }
    let key = camel_case(name);
    let value = json_value(src, &key, value);
    Some(Parsed { declaration: Declaration { key, value }, important })
}

/// Splits `!important` (any case, whitespace allowed after the `!`) off the end of a value.
fn strip_important(value: &[Token]) -> (&[Token], bool) {
    let Some(last) = value.last() else {
        return (value, false);
    };
    let is_important = matches!(&last.kind, Kind::Ident(word) if word.eq_ignore_ascii_case("important"));
    if !is_important {
        return (value, false);
    }
    let before = trim(&value[..value.len() - 1]);
    match before.last() {
        Some(bang) if bang.kind == Kind::Delim('!') => (trim(&before[..before.len() - 1]), true),
        _ => (value, false),
    }
}

/// `background-color` to `backgroundColor`, `-webkit-user-select` to `WebkitUserSelect`, `-ms-x`
/// to `msX` as React writes it, and a custom property verbatim.
pub(super) fn camel_case(name: &str) -> String {
    if name.starts_with("--") {
        return name.to_owned();
    }
    let lower = name.to_ascii_lowercase();
    let mut key = String::new();
    let mut upper_next = false;
    for c in lower.chars() {
        if c == '-' {
            upper_next = true;
        } else if upper_next {
            key.push(c.to_ascii_uppercase());
            upper_next = false;
        } else {
            key.push(c);
        }
    }
    if lower.starts_with("-ms-") {
        key[..1].make_ascii_lowercase();
    }
    key
}

fn json_value(src: &str, key: &str, value: &[Token]) -> String {
    if value.len() == 1 && value[0].kind == Kind::Number && UNITLESS.contains(&key) {
        if let Some(number) = json_number(&src[value[0].start..value[0].end]) {
            return number;
        }
    }
    json_string(&value_text(src, value))
}

/// The value as CSS text, with every comment and run of whitespace as one space.
fn value_text(src: &str, tokens: &[Token]) -> String {
    let mut text = String::new();
    for token in tokens {
        if token.kind == Kind::Whitespace {
            text.push(' ');
        } else {
            text.push_str(&src[token.start..token.end]);
        }
    }
    text
}

fn json_number(text: &str) -> Option<String> {
    let number: f64 = text.parse().ok()?;
    if !number.is_finite() {
        return None;
    }
    if number.fract() == 0.0 && number.abs() < 1e15 {
        return Some(format!("{}", number as i64));
    }
    Some(number.to_string())
}

/// The JSON object text `StyleTable::intern` takes, members in the order of `declarations`.
pub fn render_declarations(declarations: &[Declaration]) -> String {
    object_text(declarations)
}

/// Appends `declaration`, replacing an earlier one of the same key: a JSON object cannot repeat a
/// key, and the later declaration of a key is the one CSS keeps.
pub(super) fn push_declaration(list: &mut Vec<Declaration>, declaration: Declaration) {
    list.retain(|earlier| earlier.key != declaration.key);
    list.push(declaration);
}
