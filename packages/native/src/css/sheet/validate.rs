//! Which declarations of a sheet take part in the cascade.
//!
//! CSS ignores a declaration it cannot read, so `right: bogus !important` must not remove an
//! inline `right`. The cascade works on declarations before any style is parsed, so each one is
//! judged once, when its sheet is loaded, by the check `StyleTable::intern` runs on a style.

use rustc_hash::FxHashMap;

use crate::css::lenient::{object_text, Declaration};
use crate::css::var_substitution::mentions_var;
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
        let accepted = parse_style(alone.as_bytes()).is_ok_and(|style| style != StyleDesc::default());
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
