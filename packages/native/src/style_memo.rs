//! Answers about one style, or about a pair of styles, that depend on nothing but the styles.
//!
//! An interned style is one `Arc` however many elements carry it (`StyleTable::intern`), and a style
//! is not changed once it is shared, so the address of the `Arc` names its content. The questions
//! that are put to a style on every restyle and every build (does a hover of it only paint, does a
//! restyle from this to that only paint) parse its borders and fold its pointer-state refinements
//! each time, and the page asks them of a handful of distinct styles.

use std::sync::{Arc, Weak};

use rustc_hash::FxHashMap;

use crate::style::StyleDesc;

/// The most entries kept. A table that reaches it drops the entries of styles nothing holds any more,
/// and then all of them.
const LIMIT: usize = 512;

struct Entry<V> {
    /// A weak reference keeps the allocation, so the address the entry is keyed by cannot be given to
    /// another style while the entry lives, and does not keep the style: an entry of a style that
    /// nothing holds can be told by its count.
    first: Weak<StyleDesc>,
    second: Option<Weak<StyleDesc>>,
    value: V,
}

impl<V> Entry<V> {
    fn is_held(&self) -> bool {
        self.first.strong_count() > 0 && self.second.as_ref().is_none_or(|second| second.strong_count() > 0)
    }
}

pub(crate) struct StyleMemo<V> {
    entries: FxHashMap<(usize, usize), Entry<V>>,
    hits: u64,
    computations: u64,
}

impl<V> Default for StyleMemo<V> {
    fn default() -> Self {
        Self { entries: FxHashMap::default(), hits: 0, computations: 0 }
    }
}

impl<V: Copy> StyleMemo<V> {
    /// What `compute` says of `style`, computed once for the allocation `style` is.
    pub(crate) fn of_one(&mut self, style: &Arc<StyleDesc>, compute: impl FnOnce(&StyleDesc) -> V) -> V {
        let key = (Arc::as_ptr(style) as usize, 0);
        if let Some(entry) = self.entries.get(&key) {
            self.hits += 1;
            return entry.value;
        }
        let value = compute(style);
        self.insert(key, Entry { first: Arc::downgrade(style), second: None, value });
        value
    }

    /// What `compute` says of `first` and `second`, computed once for the pair of allocations.
    pub(crate) fn of_two(&mut self, first: &Arc<StyleDesc>, second: &Arc<StyleDesc>, compute: impl FnOnce(&StyleDesc, &StyleDesc) -> V) -> V {
        let key = (Arc::as_ptr(first) as usize, Arc::as_ptr(second) as usize);
        if let Some(entry) = self.entries.get(&key) {
            self.hits += 1;
            return entry.value;
        }
        let value = compute(first, second);
        self.insert(key, Entry { first: Arc::downgrade(first), second: Some(Arc::downgrade(second)), value });
        value
    }

    fn insert(&mut self, key: (usize, usize), entry: Entry<V>) {
        self.computations += 1;
        if self.entries.len() >= LIMIT {
            self.entries.retain(|_, entry| entry.is_held());
            if self.entries.len() >= LIMIT {
                self.entries.clear();
            }
        }
        self.entries.insert(key, entry);
    }

    /// Answers found kept, and answers computed, since the memo was made.
    pub(crate) fn counts(&self) -> (u64, u64) {
        (self.hits, self.computations)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style(json: &str) -> Arc<StyleDesc> {
        Arc::new(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn an_answer_is_computed_once_for_a_style_and_once_for_a_pair() {
        let mut memo = StyleMemo::<u32>::default();
        let (a, b) = (style(r#"{"width":1}"#), style(r#"{"width":1}"#));
        assert_eq!(memo.of_one(&a, |_| 1), 1);
        assert_eq!(memo.of_one(&a, |_| panic!("kept")), 1);
        assert_eq!(memo.of_one(&b, |_| 2), 2, "an equal style in another allocation is asked for itself");
        assert_eq!(memo.of_two(&a, &b, |_, _| 3), 3);
        assert_eq!(memo.of_two(&a, &b, |_, _| panic!("kept")), 3);
        assert_eq!(memo.of_two(&b, &a, |_, _| 4), 4, "a pair is ordered");
        assert_eq!(memo.counts(), (2, 4));
    }

    #[test]
    fn a_full_memo_lets_go_of_the_styles_nothing_holds_and_then_of_the_rest() {
        let mut memo = StyleMemo::<u32>::default();
        let kept = style(r#"{"width":1}"#);
        memo.of_one(&kept, |_| 7);
        for _ in 0..LIMIT - 1 {
            let gone = style(r#"{"height":1}"#);
            memo.of_one(&gone, |_| 0);
        }
        assert_eq!(memo.entries.len(), LIMIT);
        let next = style(r#"{"height":2}"#);
        memo.of_one(&next, |_| 1);
        assert_eq!(memo.entries.len(), 2, "the entries of styles that were dropped are gone, the one still held stays");
        assert_eq!(memo.of_one(&kept, |_| panic!("kept")), 7);
        let held: Vec<_> = (0..LIMIT).map(|_| style(r#"{"height":3}"#)).collect();
        for style in &held {
            memo.of_one(style, |_| 0);
        }
        assert!(memo.entries.len() < LIMIT, "a memo of held styles is emptied when it is full");
    }
}
