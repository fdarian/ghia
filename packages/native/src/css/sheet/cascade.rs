//! What the rules an element matched make of its style.
//!
//! The cascade runs on declarations, before any style is parsed: the normal declarations of the
//! matched rules in cascade order, then the element's own inline declarations in written order,
//! then the important declarations of the matched rules. A key declared again replaces the
//! earlier one and moves to the end, which is where `css::covers` reads written order from when
//! the merged text is interned.

use std::sync::{Arc, Weak};

use rustc_hash::FxHashMap;

use crate::css::covers;
use crate::css::lenient::Declaration;
use crate::style::StyleDesc;

use super::declarations::render_declarations;
use super::index::RuleIndex;
use super::selector::Specificity;

/// The rules an element matched. Equal lists share one allocation, so two elements that match
/// the same rules compare by pointer and share a cascaded style.
pub struct MatchedRules {
    /// Rule numbers in the order their normal declarations apply.
    pub normal: Vec<u32>,
    /// Rule numbers that have `!important` declarations, in the order those apply.
    pub important: Vec<u32>,
}

type Key = Vec<(u32, Specificity)>;

#[derive(Default)]
pub struct MatchedInterner {
    lists: FxHashMap<Key, Weak<MatchedRules>>,
    /// How many lists were held after the last prune: a prune is due when the table doubles.
    pruned_at: usize,
}

impl MatchedInterner {
    pub fn intern(&mut self, index: &RuleIndex, matched: Key) -> Arc<MatchedRules> {
        if let Some(live) = self.lists.get(matched.as_slice()).and_then(Weak::upgrade) {
            return live;
        }
        if self.lists.len() >= self.pruned_at.saturating_mul(2).max(64) {
            self.lists.retain(|_, list| list.strong_count() > 0);
            self.pruned_at = self.lists.len();
        }
        let list = Arc::new(MatchedRules {
            normal: matched.iter().map(|(rule, _)| *rule).collect(),
            important: index.important_order(&matched),
        });
        self.lists.insert(matched, Arc::downgrade(&list));
        list
    }
}

/// Whether the JSON text of a value is a CSS-wide keyword string. Such a declaration takes back
/// what earlier declarations of its property set and gives nothing in return.
pub(super) fn is_css_wide(value: &str) -> bool {
    if !value.starts_with('"') {
        return false;
    }
    let Ok(text) = serde_json::from_str::<String>(value) else {
        return false;
    };
    ["unset", "initial", "inherit", "revert", "revert-layer"]
        .iter()
        .any(|keyword| text.trim().eq_ignore_ascii_case(keyword))
}

fn apply(list: &mut Vec<Declaration>, declaration: &Declaration) {
    list.retain(|earlier| earlier.key != declaration.key);
    if !is_css_wide(&declaration.value) {
        list.push(declaration.clone());
        return;
    }
    if let Some(key) = covers::key_id(&declaration.key) {
        let covered = covers::covered_by(key);
        if !covered.is_empty() {
            list.retain(|earlier| covers::key_id(&earlier.key).is_none_or(|earlier| !covered.contains(&earlier)));
        }
    }
}

/// The merged declarations of the matched rules and the element's own, as the style prop's JSON.
pub fn merge(index: &RuleIndex, matched: &MatchedRules, own: &[Declaration]) -> String {
    let mut list: Vec<Declaration> = Vec::new();
    for rule in &matched.normal {
        for declaration in &index.rules[*rule as usize].normal {
            apply(&mut list, declaration);
        }
    }
    for declaration in own {
        apply(&mut list, declaration);
    }
    for rule in &matched.important {
        for declaration in &index.rules[*rule as usize].important {
            apply(&mut list, declaration);
        }
    }
    render_declarations(&list)
}

struct Cascaded {
    /// Held so the addresses the entry is keyed by cannot be reused by other values.
    _matched: Arc<MatchedRules>,
    _own: Option<Arc<StyleDesc>>,
    /// `None` when the merged text did not parse: the element then has its own style alone.
    style: Option<Arc<StyleDesc>>,
}

/// The cascaded style of each pair of matched rules and own style, so the thousands of elements
/// that match the same rules and share an own style share one merge.
///
/// Valid for one set of sheets: the tree clears it when they change.
#[derive(Default)]
pub struct CascadeCache {
    entries: FxHashMap<(usize, usize), Cascaded>,
}

fn key(matched: &Arc<MatchedRules>, own: Option<&Arc<StyleDesc>>) -> (usize, usize) {
    (Arc::as_ptr(matched) as usize, own.map_or(0, |own| Arc::as_ptr(own) as usize))
}

impl CascadeCache {
    pub fn get(&self, matched: &Arc<MatchedRules>, own: Option<&Arc<StyleDesc>>) -> Option<Option<Arc<StyleDesc>>> {
        self.entries.get(&key(matched, own)).map(|entry| entry.style.clone())
    }

    pub fn insert(
        &mut self,
        matched: &Arc<MatchedRules>,
        own: Option<&Arc<StyleDesc>>,
        style: Option<Arc<StyleDesc>>,
    ) {
        self.entries
            .insert(key(matched, own), Cascaded { _matched: matched.clone(), _own: own.cloned(), style });
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Forget the styles no element holds. The style table holds each one too, so an entry whose
    /// style has only those two holders is unused; it would keep the table from sweeping it.
    pub fn release_unused(&mut self) {
        self.entries.retain(|_, entry| entry.style.as_ref().is_some_and(|style| Arc::strong_count(style) > 2));
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}
