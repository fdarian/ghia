//! Stylesheet text to rules: the parse half of CSS stylesheet support, with no tree in sight.
//!
//! A [`StyleSheet`] holds style rules (selector list, declarations split into normal and
//! `!important`, `@layer`, source order). Declarations come out as `(camelCase key, JSON value)`,
//! the shape of the style prop, so [`render_declarations`] gives the text `StyleTable::intern`
//! parses and every value goes through the parser inline styles use. What this engine does not
//! implement (other at-rules, selectors with other pseudo-classes) is skipped and listed in
//! [`StyleSheet::unsupported`] rather than failing the sheet.
//!
//! The atoms and layers belong to the document, so every sheet of one document is parsed with the
//! same [`Atoms`] and [`Layers`].

// Nothing outside the tests reads the sheet until the matcher and cascade land.
#![allow(dead_code, unused_imports)]

mod atoms;
mod declarations;
mod layers;
mod matching;
mod parser;
mod selector;
mod selector_parse;
mod tokenizer;

#[cfg(test)]
mod tests;

pub use atoms::{Atom, Atoms};
pub use declarations::render_declarations;
pub use layers::{LayerId, LayerOrder, Layers};
pub use matching::{matches, ElementView};
pub use parser::parse_sheet;
pub use selector::{
    AttrMatcher, AttrOp, AttrSelector, Combinator, ComplexSelector, Compound, Simple, Specificity,
};

use crate::css::lenient::Declaration;

pub struct StyleSheet {
    pub rules: Vec<Rule>,
    /// The name of each skipped at-rule (`media`, without the `@`), and the text of each selector
    /// list that was invalid, in source order.
    pub unsupported: Vec<String>,
}

pub struct Rule {
    /// The rule applies when any of them matches; each carries its own specificity.
    pub selectors: Vec<(ComplexSelector, Specificity)>,
    pub normal: Vec<Declaration>,
    pub important: Vec<Declaration>,
    pub layer: Option<LayerId>,
    /// Position among the rules of this sheet. A nested rule follows the declarations of its
    /// parent that were written before it, and the ones written after it come later still.
    pub order: u32,
}
