//! `@property --name { syntax; inherits; initial-value }`: the registration a sheet makes.
//!
//! A rule whose descriptors do not make a registration is ignored, as the spec has it (CSS
//! Properties and Values API, the `@property` rule): `registered_properties::Registration::new`
//! says why not, and the reason is logged with the skipped rules. Which of several rules for one
//! name stands is settled by `definitions::winners`.

use crate::css::registered_properties::Registration;

use super::keyframes::split_declarations;
use super::tokenizer::{trim, Kind, Token};

/// The registration `@property <prelude> { <contents> }` makes, or the reason it makes none.
pub(super) fn parse(src: &str, prelude: &[Token], contents: &[Token]) -> Result<Registration, String> {
    let name = match trim(prelude) {
        [token] => match &token.kind {
            Kind::Ident(name) => name.clone(),
            _ => return Err("the name is not a custom property name".to_owned()),
        },
        _ => return Err("the name is not a custom property name".to_owned()),
    };
    let mut syntax = None;
    let mut inherits = None;
    let mut initial_value = None;
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
            "syntax" => {
                // Only a string is a syntax, whose content is the grammar; any other value is dropped.
                if let [token] = value {
                    if let Kind::Str(grammar) = &token.kind {
                        syntax = Some(grammar.clone());
                    }
                }
            }
            "inherits" => inherits = Some(text.to_owned()),
            "initial-value" => initial_value = Some(text.to_owned()),
            _ => {}
        }
    }
    Registration::new(&name, syntax.as_deref(), inherits.as_deref(), initial_value.as_deref())
}
