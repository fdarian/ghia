//! Stylesheet text to rules: the parse half of CSS stylesheet support, with no tree in sight.
//!
//! A [`StyleSheet`] holds style rules (selector list, declarations split into normal and
//! `!important`, `@layer`, source order). Declarations come out as `(camelCase key, JSON value)`,
//! the shape of the style prop, so [`render_declarations`] gives the text `StyleTable::intern`
//! parses and every value goes through the parser inline styles use. What this engine does not
//! implement (at-rules other than `@layer`, `@media`, `@supports`, `@keyframes` and `@property`,
//! selectors with other pseudo-classes) is skipped and listed in
//! [`StyleSheet::unsupported`] rather than failing the sheet.
//!
//! The atoms and layers belong to the document, so every sheet of one document is parsed with the
//! same [`Atoms`] and [`Layers`].

// The tests read the parts of a sheet through the re-exports below, which nothing else needs.
#![cfg_attr(not(test), allow(unused_imports))]

mod atoms;
mod cascade;
mod conditions;
mod declarations;
mod definitions;
mod document;
mod font_face;
mod has;
mod index;
mod initial;
mod invalidation;
mod keyframes;
mod layers;
mod live_states;
mod matching;
mod nth;
mod parse_cache;
mod parser;
mod positions;
mod property_rules;
mod pseudo;
mod reload;
mod selector;
mod selector_parse;
mod share;
mod states;
mod supports;
mod tokenizer;
mod tree;
mod tree_states;
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
pub use definitions::Defined;
pub use font_face::{FaceSource, FaceStyle, FontFaceRule, SheetFontFaces};
pub use keyframes::{KeyframeBlock, KeyframesRule, SheetKeyframes};
pub use has::{HasArguments, HasInvalidation, HasRead, RelativeSelector};
pub use invalidation::{Invalidation, Reach};
pub use layers::{LayerId, LayerOrder, Layers};
pub use live_states::{FocusChain, LiveInputs, LiveStateReach, LiveStates, PointerChains};
pub use matching::{matches, AttrValue, ElementView, SiblingTest};
pub use parser::parse_sheet;
pub use pseudo::{Pseudo, PseudoMatches, PseudoStyle};
pub use states::State;
pub use tree_states::{TreeState, TreeStateReach, TreeStates};
pub(crate) use states::{is_state_block, merge_own};
pub(crate) use initial::style_of as initial_style_of;
pub(crate) use wide_keyword::resolve as resolve_wide_keywords;
pub use selector::{
    AttrMatcher, AttrName, AttrOp, AttrSelector, Combinator, ComplexSelector, Compound, SelectorList, Simple, Specificity, TypeName,
};

use crate::css::lenient::Declaration;
use crate::css::registered_properties::Registration;

pub struct StyleSheet {
    pub rules: Vec<Rule>,
    /// The `@keyframes` of the sheet, in source order.
    pub keyframes: Vec<Defined<KeyframesRule>>,
    /// The valid `@property` rules of the sheet, in source order.
    pub properties: Vec<Defined<Registration>>,
    /// The valid `@font-face` rules of the sheet, in source order.
    pub font_faces: Vec<Defined<FontFaceRule>>,
    /// The name of each skipped at-rule (`container`, without the `@`), the head of each `@media`
    /// and `@supports` that was malformed, the head and the reason of each `@property` that makes
    /// no registration, and the text of each selector list that was invalid, in source order.
    pub unsupported: Vec<String>,
}

pub struct Rule {
    /// The rule applies when any of them matches; each carries its own specificity.
    pub selectors: Vec<(ComplexSelector, Specificity)>,
    pub normal: Vec<Declaration>,
    pub important: Vec<Declaration>,
    pub layer: Option<LayerId>,
    /// The `@media` queries the rule stands under, all of which have to match.
    pub conditions: Option<std::sync::Arc<conditions::Conditions>>,
    /// Position among the rules of this sheet. A nested rule follows the declarations of its
    /// parent that were written before it, and the ones written after it come later still.
    pub order: u32,
}
