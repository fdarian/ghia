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

// The tests read the parts of a sheet through the re-exports below, which nothing else needs.
#![cfg_attr(not(test), allow(unused_imports))]

mod atoms;
mod cascade;
mod declarations;
mod document;
mod index;
mod initial;
mod invalidation;
mod layers;
mod matching;
mod parse_cache;
mod parser;
mod reload;
mod selector;
mod selector_parse;
mod share;
mod states;
mod tokenizer;
mod tree;
mod validate;
mod view;
mod wide_keyword;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tree_tests;

pub use atoms::{Atom, Atoms};
pub use cascade::{CascadeCache, MatchedRules};
pub use document::{ClassAtoms, ElementCss, StyleSheets};
pub use declarations::render_declarations;
pub use invalidation::{Invalidation, Reach};
pub use layers::{LayerId, LayerOrder, Layers};
pub use matching::{matches, AttrValue, ElementView, SiblingTest};
pub use parser::parse_sheet;
pub use states::State;
pub(crate) use states::{is_state_block, merge_own};
pub(crate) use initial::style_of as initial_style_of;
pub(crate) use wide_keyword::resolve as resolve_wide_keywords;
pub use selector::{
    AttrMatcher, AttrName, AttrOp, AttrSelector, Combinator, ComplexSelector, Compound, SelectorList, Simple, Specificity, TypeName,
};

use crate::css::lenient::Declaration;

pub struct StyleSheet {
    pub rules: Vec<Rule>,
    /// The name of each skipped at-rule (`media`, without the `@`), and the text of each selector
    /// list that was invalid, in source order.
    pub unsupported: Vec<String>,
}

#[derive(Clone)]
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
