//! What the rules an element matched make of its style.
//!
//! The cascade runs on declarations, before any style is parsed: the normal declarations of the
//! matched rules in cascade order, then the element's own inline declarations in written order,
//! then the important declarations of the matched rules, then the element's own inline declarations
//! that were written `!important`, which beat an author `!important` as in CSS. A key declared again replaces the
//! earlier one and moves to the end, which is where `css::covers` reads written order from when
//! the merged text is interned.

use std::sync::{Arc, Weak};

use rustc_hash::FxHashMap;

use crate::css::covers::{self, KeyId};
use crate::css::lenient::Declaration;
use crate::style::StyleDesc;

use super::declarations::render_declarations;
use super::index::RuleIndex;
use super::initial;
use super::states::{self, Applies, RuleMatch};

/// The rules an element matched. Equal lists share one allocation, so two elements that match
/// the same rules compare by pointer and share a cascaded style.
pub struct MatchedRules {
    /// The rules in the order their normal declarations apply.
    pub normal: Vec<Applies>,
    /// The rules that have `!important` declarations, in the order those apply.
    pub important: Vec<Applies>,
    /// Whether a rule applies under a pointer or focus state (`states.rs`).
    conditional: bool,
}

type Key = Vec<RuleMatch>;

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
            normal: matched.iter().map(|found| Applies { rule: found.rule, condition: found.condition }).collect(),
            important: index.important_order(&matched),
            conditional: matched.iter().any(|found| found.condition.is_some()),
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

pub(super) fn apply(list: &mut Vec<Declaration>, declaration: &Declaration) {
    list.retain(|earlier| earlier.key != declaration.key);
    if !is_css_wide(&declaration.value) {
        list.push(declaration.clone());
        return;
    }
    let Some(key) = covers::key_id(&declaration.key) else {
        return;
    };
    let covered = covers::covered_by(key);
    let longhands: Vec<KeyId> = if covered.is_empty() {
        vec![key]
    } else {
        list.retain(|earlier| covers::key_id(&earlier.key).is_none_or(|earlier| !covered.contains(&earlier)));
        covered.iter().copied().filter(|target| covers::covered_by(*target).is_empty()).collect()
    };
    // A shorthand written earlier still gives the longhand a value, and the keyword has to take
    // that back: the initial value written after it wins over it.
    for longhand in longhands {
        if let Some(initial) = initial::of(longhand).filter(|_| is_shadowed(list, longhand)) {
            list.push(initial.clone());
        }
    }
}

fn is_shadowed(list: &[Declaration], longhand: KeyId) -> bool {
    list.iter()
        .any(|earlier| covers::key_id(&earlier.key).is_some_and(|shorthand| covers::covered_by(shorthand).contains(&longhand)))
}

/// The merged declarations of the matched rules and the element's own, as the style prop's JSON.
/// `own_important` are the own declarations that were written `!important`.
pub(super) fn merge(
    index: &RuleIndex,
    matched: &MatchedRules,
    own: &[Declaration],
    own_important: &[Declaration],
    logged: &mut states::LoggedFolds,
) -> String {
    if matched.conditional || own.iter().any(|declaration| states::is_state_block(&declaration.key)) {
        return states::merge(index, matched, own, own_important, logged);
    }
    let mut list: Vec<Declaration> = Vec::new();
    for applies in &matched.normal {
        for declaration in &index.rules[applies.rule as usize].normal {
            apply(&mut list, declaration);
        }
    }
    for declaration in own {
        apply(&mut list, declaration);
    }
    for applies in &matched.important {
        for declaration in &index.rules[applies.rule as usize].important {
            apply(&mut list, declaration);
        }
    }
    for declaration in own_important {
        apply(&mut list, declaration);
    }
    render_declarations(&list)
}

struct Cascaded {
    /// Weak so the entry does not keep what its key is the address of alive, and the allocation
    /// stays reserved while the entry exists, so the address cannot be reused by another value.
    matched: Weak<MatchedRules>,
    own: Option<Weak<StyleDesc>>,
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
        self.entries.insert(
            key(matched, own),
            Cascaded { matched: Arc::downgrade(matched), own: own.map(Arc::downgrade), style },
        );
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Forget the entries no element can look up again. An entry is looked up by the rules and the
    /// own style of an element, so it lives as long as its key does: the rules are held by an
    /// element (the interner and the entry hold them weakly), and the own style, if there is one,
    /// is held by an element too. What an entry's merged style is held by says nothing of that:
    /// under the user agent and universal layers an element holds the layered style, not the merge.
    ///
    /// The style table holds each own style, and so does every entry whose merge is the own style
    /// itself (the sheet names the keys an inline style sets): neither is an element, and a style
    /// no other holds would stay out of the table's sweep for as long. Many own styles that merge
    /// to one style (an inline `left` that an `!important` rule overrides, animated per frame) are
    /// each released here once the element moves on.
    ///
    /// Each pass decides from the counts as they stand when it starts and only then drops what
    /// it found dead. Dropping an entry as it is visited lowers the counts the entries after it
    /// read, so what survived would depend on the hash order, which is the entries' addresses.
    pub fn release_unused(&mut self) {
        loop {
            let mut merged_into: FxHashMap<*const StyleDesc, usize> = FxHashMap::default();
            for style in self.entries.values().filter_map(|entry| entry.style.as_ref()) {
                *merged_into.entry(Arc::as_ptr(style)).or_default() += 1;
            }
            let own_is_held = |own: &Weak<StyleDesc>| {
                own.strong_count() > 1 + merged_into.get(&own.as_ptr()).copied().unwrap_or(0)
            };
            let dead: Vec<(usize, usize)> = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.matched.strong_count() == 0 || !entry.own.as_ref().is_none_or(|own| own_is_held(own)))
                .map(|(key, _)| *key)
                .collect();
            if dead.is_empty() {
                return;
            }
            // Dropping an entry lets go of its style, which can be another entry's own style.
            for key in dead {
                self.entries.remove(&key);
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}
