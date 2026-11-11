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
pub fn merge(index: &RuleIndex, matched: &MatchedRules, own: &[Declaration], own_important: &[Declaration]) -> String {
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

    /// Forget the entries no element can look up again, or whose style no element holds. The
    /// style table holds each style too, and so does every entry that has it as its style (the
    /// merge of a sheet that names the keys an inline style sets is the own style itself): a
    /// style with no other holder is unused, and would keep the table from sweeping it.
    ///
    /// An entry is looked up by the rules and the own style of an element, so it is dead once no
    /// element holds either. Without that, many own styles that merge to one style (an inline
    /// `left` that an `!important` rule overrides, animated per frame) would each stay pinned by
    /// the entry whose merged style is still in use.
    ///
    /// Each pass decides from the counts as they stand when it starts and only then drops what
    /// it found dead. Dropping an entry as it is visited lowers the counts the entries after it
    /// read, so what survived would depend on the hash order, which is the entries' addresses.
    pub fn release_unused(&mut self) {
        loop {
            let mut held_by_cache: FxHashMap<*const StyleDesc, usize> = FxHashMap::default();
            for style in self.entries.values().filter_map(|entry| entry.style.as_ref()) {
                *held_by_cache.entry(Arc::as_ptr(style)).or_default() += 1;
            }
            // The table holds a style, and every entry that has it as its style.
            let held_elsewhere = |style: &Arc<StyleDesc>| Arc::strong_count(style) - 1 - held_by_cache[&Arc::as_ptr(style)];
            let own_is_held = |entry: &Cascaded| {
                // The table holds an own style, and an entry whose merge is the own style holds it.
                entry.own.as_ref().is_none_or(|own| own.strong_count() > 1 + held_by_cache.get(&own.as_ptr()).copied().unwrap_or(0))
            };

            // An entry without an own style has no count of its own to read: it is looked up by
            // the elements that matched its rules and declared no style. Elements that do declare
            // one are counted by their entries, so what is left of a style's holders is the
            // elements that can use an entry without one.
            let mut claimed_by_own: FxHashMap<*const StyleDesc, usize> = FxHashMap::default();
            for entry in self.entries.values() {
                let Some(style) = entry.style.as_ref() else { continue };
                if entry.own.is_some() && entry.matched.strong_count() > 0 && own_is_held(entry) {
                    *claimed_by_own.entry(Arc::as_ptr(style)).or_default() += 1;
                }
            }

            let dead: Vec<(usize, usize)> = self
                .entries
                .iter()
                .filter(|(_, entry)| {
                    let Some(style) = entry.style.as_ref() else { return true };
                    let held = held_elsewhere(style);
                    let claimed = claimed_by_own.get(&Arc::as_ptr(style)).copied().unwrap_or(0);
                    let lookable = match entry.own {
                        Some(_) => own_is_held(entry),
                        None => held > claimed,
                    };
                    entry.matched.strong_count() == 0 || held == 0 || !lookable
                })
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
