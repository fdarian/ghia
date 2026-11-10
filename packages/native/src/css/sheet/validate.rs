//! Which declarations of a sheet take part in the cascade.
//!
//! CSS ignores a declaration it cannot read, so `right: bogus !important` must not remove an
//! inline `right`. The cascade works on declarations before any style is parsed, so each one is
//! judged once, when its sheet is loaded, by the check `StyleTable::intern` runs on a style.

use std::borrow::Cow;

use rustc_hash::FxHashMap;

use crate::color::{ColorContext, Scheme};
use crate::css::lenient::{object_text, Declaration};
use crate::css::var_substitution::mentions_var;
use crate::events::state_styles::without_invalid_values;
use crate::retained_tree::parse_style;
use crate::style::StyleDesc;

use super::cascade::is_css_wide;
use super::Rule;

/// How many verdicts are remembered before the memory starts over.
const VERDICT_LIMIT: usize = 4096;

#[derive(Default)]
pub struct Validator {
    /// Keyed by the declaration alone as the style prop's JSON, so a declaration that several
    /// rules repeat is parsed once, and again only after a sheet change if it was forgotten.
    verdicts: FxHashMap<String, bool>,
}

impl Validator {
    /// Drops the declarations the style parser does not accept from `rules`, and the rules left
    /// with none.
    pub fn filter(&mut self, rules: &mut Vec<Rule>) {
        for rule in rules.iter_mut() {
            rule.normal.retain(|declaration| self.accepts(declaration));
            rule.important.retain(|declaration| self.accepts(declaration));
        }
        rules.retain(|rule| !rule.normal.is_empty() || !rule.important.is_empty());
    }

    /// The declarations of an element's own style that may take part in the cascade. An inline
    /// value that is `null` or `""` is no value in React DOM, and one the style parser rejects is
    /// ignored by CSS, so neither may take back what a sheet declared. A nested object (a state
    /// style) is not a declaration of a property and passes.
    pub fn filter_own(&mut self, own: Vec<Declaration>) -> Vec<Declaration> {
        own.into_iter()
            .filter(|declaration| match declaration.value.as_str() {
                "null" | "\"\"" => false,
                value if value.starts_with('{') || value.starts_with('[') => true,
                _ => self.accepts(declaration),
            })
            .collect()
    }

    fn accepts(&mut self, declaration: &Declaration) -> bool {
        // Custom properties take any value, a `var()` is only known at build time, and a CSS-wide
        // keyword is the cascade's own to apply.
        if declaration.key.starts_with("--") || mentions_var(declaration.value.as_bytes()) || is_css_wide(&declaration.value) {
            return true;
        }
        let alone = object_text(std::slice::from_ref(declaration));
        if let Some(verdict) = self.verdicts.get(&alone) {
            return *verdict;
        }
        // A key the style does not know parses and sets nothing, which CSS also ignores.
        let accepted = parse_style(alone.as_bytes()).is_ok_and(|style| style != StyleDesc::default() && is_valid(&style));
        if !accepted {
            log::warn!("Stylesheet: declaration ignored, not a valid {}: {}", declaration.key, declaration.value);
        }
        if self.verdicts.len() >= VERDICT_LIMIT {
            self.verdicts.clear();
        }
        self.verdicts.insert(alone, accepted);
        accepted
    }
}

/// Whether CSS would keep the declaration the style was parsed from: no value of it is one the
/// style drops as invalid when a state style layers over its base, and a colour resolves, which
/// the style parser does not check for the properties below.
fn is_valid(style: &StyleDesc) -> bool {
    if !matches!(without_invalid_values(style), Cow::Borrowed(_)) {
        return false;
    }
    let colors = ColorContext::root(Scheme::Light);
    [&style.color, &style.outline_color, &style.text_decoration_color]
        .into_iter()
        .all(|color| color.as_deref().is_none_or(|text| colors.resolve(text).is_some()))
}
