//! Style sharing: elements that look the same to the selectors are matched once per flush.
//!
//! An element's matched rules depend only on what the key below holds when every rule that could
//! match it is self-contained (`RuleIndex`: one compound, nothing read of the tree around the
//! element). A mount of a thousand rows with the same classes then matches one and reuses its
//! answer for the rest. An element with a candidate rule that reads its surroundings
//! (a combinator, `:root`, `[style]`) is matched in full, and the memo remembers that for its key.
//!
//! The memo lives for one flush: the tree does not change while it matches, and a sheet reload
//! comes before it. Elements that mostly differ (a unique attribute value on each) would pay a key
//! and a map entry each for nothing, so the memo is judged in windows: after [`TRIAL`] lookups of
//! shareable keys (or of unshareable ones) it is paused for the next [`PAUSE`] elements unless at
//! least one in [`MIN_HIT_RATE`] of the window hit, and then a new window starts. The elements
//! that open a flush are often app chrome with nothing in common with the list after it, so one
//! window at the start of the flush is not allowed to decide for all of it.

use rustc_hash::FxHashMap;
use smallvec::SmallVec;

use crate::retained_tree::RetainedElement;

use super::atoms::Atom;
use super::document::StyleSheets;
use super::matching::ElementView;
use super::states::RuleMatch;
use super::view::TreeView;

pub(super) type MatchedList = Vec<RuleMatch>;

#[cfg(test)]
thread_local! {
    /// Times a full match of an element against the index ran, which the tests compare with the
    /// number of elements to see what was shared.
    pub(super) static FULL_MATCHES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// Keys the memo inserted, which stops growing once a flush gives the memo up.
    pub(super) static INSERTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// Keys the memo built, which stops growing while it is paused.
    pub(super) static KEY_BUILDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Lookups of one kind (shareable, or unshareable) a window holds before it is judged.
const TRIAL: usize = 64;
/// The memo is kept when at least one lookup in this many of a window hit.
const MIN_HIT_RATE: usize = 4;
/// Elements matched directly, with no key, after a window that did not pay.
const PAUSE: usize = 256;

pub(super) fn count_full_match() {
    #[cfg(test)]
    FULL_MATCHES.with(|count| count.set(count.get() + 1));
}

fn count_insert() {
    #[cfg(test)]
    INSERTS.with(|count| count.set(count.get() + 1));
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
    /// What the window being judged has seen. A lookup of an unshareable key never hits, and is
    /// not counted among the shareable ones, which are what a hit rate is a rate of: but a window
    /// of nothing else must end too, or every element of it would pay a key for nothing.
    shareable: usize,
    unshareable: usize,
    hits: usize,
    /// Elements still to be matched directly.
    paused: usize,
}

impl StyleSharing {
    pub(super) fn is_empty(&self, found: &Found) -> bool {
        match found {
            Found::Shared(list) => self.lists[*list].is_empty(),
            Found::Own(list) => list.is_empty(),
        }
    }

    /// Ends the window when it is full: the memo is paused unless it paid. Whether it did.
    fn judged(&mut self) -> bool {
        if self.shareable < TRIAL && self.unshareable < TRIAL {
            return true;
        }
        let pays = self.hits * MIN_HIT_RATE >= TRIAL;
        self.shareable = 0;
        self.unshareable = 0;
        self.hits = 0;
        if !pays {
            self.paused = PAUSE;
        }
        pays
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
        if self.paused > 0 {
            self.paused -= 1;
            return Found::Own(index.matching(view, id, classes));
        }
        self.build_key(sheets, element, view, id, classes);
        match self.slots.get(self.key.as_slice()) {
            Some(Slot::Shared(list)) => {
                let list = *list;
                self.shareable += 1;
                self.hits += 1;
                self.judged();
                return Found::Shared(list);
            }
            Some(Slot::Unshareable) => {
                self.unshareable += 1;
                self.judged();
                return Found::Own(index.matching(view, id, classes));
            }
            None => {}
        }
        let (matched, shareable) = index.matching_in_full(view, id, classes);
        if !shareable {
            self.unshareable += 1;
            // A window that has just paused the memo has no use for this key either.
            if self.judged() {
                count_insert();
                self.slots.insert(self.key.as_slice().into(), Slot::Unshareable);
            }
            return Found::Own(matched);
        }
        self.shareable += 1;
        if !self.judged() {
            return Found::Own(matched);
        }
        self.lists.push(matched);
        let list = self.lists.len() - 1;
        count_insert();
        self.slots.insert(self.key.as_slice().into(), Slot::Shared(list));
        Found::Shared(list)
    }

    /// Everything a self-contained selector can read of an element, and what decides which rules
    /// are candidates: the type, the id, the class set, and for each attribute name any selector
    /// mentions its value (presence only for `style`, which only an unshareable rule reads).
    fn build_key(&mut self, sheets: &StyleSheets, element: &RetainedElement, view: &TreeView<'_>, id: Option<Atom>, classes: &[Atom]) {
        #[cfg(test)]
        KEY_BUILDS.with(|count| count.set(count.get() + 1));
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
