//! Style sharing: elements that look the same to the selectors are matched once per flush.
//!
//! An element's matched rules depend only on what the key below holds when every rule that could
//! match it is self-contained (`RuleIndex`: one compound, nothing read of the tree around the
//! element). A mount of a thousand rows with the same classes then matches one and reuses its
//! answer for the rest. An element with a candidate rule that reads its surroundings
//! (a combinator, `:root`, `[style]`) is matched in full, and the memo remembers that for its key.
//!
//! The memo lives for one flush: the tree does not change while it matches, and a sheet reload
//! comes before it.

use rustc_hash::FxHashMap;
use smallvec::SmallVec;

use crate::retained_tree::RetainedElement;

use super::atoms::Atom;
use super::document::StyleSheets;
use super::matching::ElementView;
use super::selector::Specificity;
use super::view::TreeView;

pub(super) type MatchedList = Vec<(u32, Specificity)>;

#[cfg(test)]
thread_local! {
    /// Times a full match of an element against the index ran, which the tests compare with the
    /// number of elements to see what was shared.
    pub(super) static FULL_MATCHES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(super) fn count_full_match() {
    #[cfg(test)]
    FULL_MATCHES.with(|count| count.set(count.get() + 1));
}

enum Slot {
    /// A rule that reads more than the key could be a candidate: every element of this key is
    /// matched in full.
    Unshareable,
    Shared(usize),
}

/// What the match of an element came to.
pub(super) enum Found {
    /// The list at this position of [`StyleSharing::lists`].
    Shared(usize),
    Own(MatchedList),
}

#[derive(Default)]
pub(super) struct StyleSharing {
    slots: FxHashMap<Box<[u8]>, Slot>,
    /// One list per distinct key that was matched in full and shared.
    pub(super) lists: Vec<MatchedList>,
    key: Vec<u8>,
}

impl StyleSharing {
    pub(super) fn is_empty(&self, found: &Found) -> bool {
        match found {
            Found::Shared(list) => self.lists[*list].is_empty(),
            Found::Own(list) => list.is_empty(),
        }
    }

    /// The rules `element` matches. `id` and `classes` are the element's atoms.
    pub(super) fn matching(
        &mut self,
        sheets: &StyleSheets,
        element: &RetainedElement,
        view: &TreeView<'_>,
        id: Option<Atom>,
        classes: &[Atom],
    ) -> Found {
        let index = &sheets.index;
        if !index.shares() {
            return Found::Own(index.matching(view, id, classes));
        }
        self.build_key(sheets, element, view, id, classes);
        match self.slots.get(self.key.as_slice()) {
            Some(Slot::Shared(list)) => return Found::Shared(*list),
            Some(Slot::Unshareable) => return Found::Own(index.matching(view, id, classes)),
            None => {}
        }
        let (matched, shareable) = index.matching_in_full(view, id, classes);
        if !shareable {
            self.slots.insert(self.key.as_slice().into(), Slot::Unshareable);
            return Found::Own(matched);
        }
        self.lists.push(matched);
        let list = self.lists.len() - 1;
        self.slots.insert(self.key.as_slice().into(), Slot::Shared(list));
        Found::Shared(list)
    }

    /// Everything a self-contained selector can read of an element, and what decides which rules
    /// are candidates: the type, the id, the class set, and for each attribute name any selector
    /// mentions its value (presence only for `style`, which only an unshareable rule reads).
    fn build_key(&mut self, sheets: &StyleSheets, element: &RetainedElement, view: &TreeView<'_>, id: Option<Atom>, classes: &[Atom]) {
        let key = &mut self.key;
        key.clear();
        let is_svg = element.is_svg();
        key.push(u8::from(is_svg));
        push_atom(key, view.tag());
        push_atom(key, id);
        let mut set: SmallVec<[u32; 8]> = classes.iter().map(|class| class.index()).collect();
        set.sort_unstable();
        set.dedup();
        key.extend_from_slice(&(set.len() as u32).to_le_bytes());
        for class in set {
            key.extend_from_slice(&class.to_le_bytes());
        }
        for name in sheets.index.shared_attributes(is_svg) {
            if *name == sheets.style {
                key.push(u8::from(element.own_style().is_some()));
                continue;
            }
            match element.attribute(sheets.atoms.name(*name)) {
                Some(value) => {
                    key.push(1);
                    key.extend_from_slice(&(value.len() as u32).to_le_bytes());
                    key.extend_from_slice(value.as_bytes());
                }
                None => key.push(0),
            }
        }
    }
}

fn push_atom(key: &mut Vec<u8>, atom: Option<Atom>) {
    key.extend_from_slice(&atom.map_or(u32::MAX, Atom::index).to_le_bytes());
}
