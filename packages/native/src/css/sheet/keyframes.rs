//! `@keyframes` in a sheet: the name, and the keyframes with the declarations each sets.
//!
//! A sheet's keyframes are what the animation engine reads as a second source of the names
//! `animation-name` refers to (`motion::KeyframesRegistry::set_sheet`), and win over a name
//! `defineKeyframes` defined, as the document's own rule does on the web. This file only reads the
//! rule: which properties can be animated, and which values parse, is the engine's to say when it
//! takes the keyframes, as for a definition from script.
//!
//! What CSS Animations 1 asks of the rule, which is kept: a keyframe selector is `from`, `to` or a
//! percentage from 0% to 100%, a list of them sharing one block; a keyframe with a selector that
//! is not one is dropped and the others stay; `!important` declarations in a keyframe are ignored.

use std::sync::Arc;

use crate::css::lenient::Declaration;

use super::declarations::parse_declaration;
use super::tokenizer::{find_close, trim, Kind, Token};
use super::validate::Validator;

#[derive(Debug, PartialEq)]
pub struct KeyframesRule {
    pub name: String,
    /// In the order written, which decides between two blocks of one offset.
    pub blocks: Vec<KeyframeBlock>,
}

#[derive(Debug, PartialEq)]
pub struct KeyframeBlock {
    /// Each in 0 to 1.
    pub offsets: Vec<f64>,
    /// As the style prop has them: a camelCase key and a JSON value. A later one of a key replaces
    /// an earlier.
    pub declarations: Vec<Declaration>,
}

/// The sets of keyframes the document's sheets define, one for each name, with a number that
/// changes whenever the set does.
#[derive(Default)]
pub struct SheetKeyframes {
    epoch: u64,
    /// By name.
    rules: Vec<Arc<KeyframesRule>>,
}

impl SheetKeyframes {
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(crate) fn rules(&self) -> &[Arc<KeyframesRule>] {
        &self.rules
    }

    #[cfg(test)]
    pub(crate) fn for_test(epoch: u64, rules: Vec<Arc<KeyframesRule>>) -> SheetKeyframes {
        SheetKeyframes { epoch, rules }
    }

    /// The set after `winners` replaced the definitions, which is this one when they are the same.
    pub(super) fn replaced_by(current: &Arc<SheetKeyframes>, winners: Vec<&Arc<KeyframesRule>>) -> Option<Arc<SheetKeyframes>> {
        let same = winners.len() == current.rules.len()
            && winners.iter().zip(&current.rules).all(|(new, held)| Arc::ptr_eq(new, held) || ***new == **held);
        (!same).then(|| {
            Arc::new(SheetKeyframes { epoch: current.epoch + 1, rules: winners.into_iter().cloned().collect() })
        })
    }
}

/// The rule `@keyframes <prelude> { <contents> }` makes, or `None` when the name is not one.
pub(super) fn parse(src: &str, prelude: &[Token], contents: &[Token], validator: &mut Validator) -> Option<KeyframesRule> {
    let name = name_of(prelude)?;
    let mut blocks = Vec::new();
    let mut index = 0;
    while index < contents.len() {
        let Some(open) = contents[index..].iter().position(|token| token.kind == Kind::OpenBrace).map(|at| index + at) else {
            break;
        };
        let close = find_close(contents, open);
        let inner = &contents[open + 1..close.min(contents.len())];
        if let Some(offsets) = offsets_of(src, &contents[index..open]) {
            let declarations = declarations_of(src, inner, validator);
            if !declarations.is_empty() {
                blocks.push(KeyframeBlock { offsets, declarations });
            }
        }
        index = close + 1;
    }
    Some(KeyframesRule { name, blocks })
}

/// A `<keyframes-name>`: an identifier that is not `none` or a CSS-wide keyword, or a string.
fn name_of(prelude: &[Token]) -> Option<String> {
    match trim(prelude) {
        [token] => match &token.kind {
            Kind::Ident(name) if !is_reserved(name) => Some(name.clone()),
            Kind::Str(name) => Some(name.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn is_reserved(name: &str) -> bool {
    ["none", "initial", "inherit", "unset", "revert", "revert-layer", "default"].iter().any(|word| name.eq_ignore_ascii_case(word))
}

/// `from`, `to` and percentages, separated by commas, as offsets. `None` when any piece is something else.
fn offsets_of(src: &str, selector: &[Token]) -> Option<Vec<f64>> {
    let mut offsets = Vec::new();
    for piece in selector.split(|token| token.kind == Kind::Comma) {
        let [token] = trim(piece) else {
            return None;
        };
        let offset = match &token.kind {
            Kind::Ident(word) if word.eq_ignore_ascii_case("from") => 0.0,
            Kind::Ident(word) if word.eq_ignore_ascii_case("to") => 1.0,
            Kind::Dimension => {
                let percent: f64 = src[token.start..token.end].strip_suffix('%')?.parse().ok()?;
                if !(0.0..=100.0).contains(&percent) {
                    return None;
                }
                percent / 100.0
            }
            _ => return None,
        };
        offsets.push(offset);
    }
    (!offsets.is_empty()).then_some(offsets)
}

fn declarations_of(src: &str, tokens: &[Token], validator: &mut Validator) -> Vec<Declaration> {
    let mut declarations: Vec<Declaration> = Vec::new();
    for piece in split_declarations(tokens) {
        let Some(parsed) = parse_declaration(src, piece) else {
            continue;
        };
        if parsed.important {
            continue;
        }
        declarations.retain(|earlier| earlier.key != parsed.declaration.key);
        declarations.push(parsed.declaration);
    }
    validator.keep(declarations)
}

/// `tokens` cut at the semicolons outside brackets.
pub(super) fn split_declarations(tokens: &[Token]) -> Vec<&[Token]> {
    let mut pieces = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for (index, token) in tokens.iter().enumerate() {
        match &token.kind {
            Kind::Semicolon if depth == 0 => {
                pieces.push(&tokens[start..index]);
                start = index + 1;
            }
            kind if kind.is_opener() => depth += 1,
            kind if kind.is_closer() => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    pieces.push(&tokens[start..]);
    pieces
}
