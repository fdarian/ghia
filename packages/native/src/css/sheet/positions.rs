//! What a child coming or going marks for the structural pseudo-classes (`:first-child`,
//! `:nth-child()`, `:empty`, ...).
//!
//! The index tells, per kind of positional selector, where it is read (`Positional`), so a document
//! whose sheets use none marks nothing here. A kind is marked as it changes:
//!
//! * `edge` (`:first-child`, `:last-child`, `:only-child`): only the two element neighbours of the
//!   child change their answer, so they are marked, one by one.
//! * `forward` and `backward` (`:nth-child()` and the other counting ones): every sibling after,
//!   or before, the child changes, which a mark for each would make quadratic when a list is
//!   built child by child. A [`SiblingRange`] is noted instead and expanded once, at the flush.
//! * `empty`: the parent, whatever kind of child came or went.
//!
//! A move is an unlink and a link, so both places are covered by the same two hooks.

use rustc_hash::FxHashMap;

use crate::retained_tree::{RetainedElement, RetainedTree};

use super::invalidation::Reach;
use super::view::count_sibling_work;

/// The siblings of `anchor`, from it (when `inclusive`) to the end of the list when `after`, or to
/// the start when not, as the list stands at the flush. An element that stays on its side of the
/// anchor between the note and the flush is covered, and one that moves has marked itself, which
/// is what makes the final positions enough.
#[derive(Clone, Copy)]
pub(crate) struct SiblingRange {
    anchor: u64,
    inclusive: bool,
    after: bool,
}

impl SiblingRange {
    fn same_as(&self, other: &SiblingRange) -> bool {
        self.anchor == other.anchor && self.inclusive == other.inclusive && self.after == other.after
    }
}

impl RetainedTree {
    fn is_matchable_id(&self, id: u64) -> bool {
        self.elements.get(&id).is_some_and(RetainedElement::is_matchable)
    }

    /// The element siblings next to `child`, which has to be in the children of `parent_id`. The
    /// search starts at the end when `from_end`: a child that was just appended is there.
    fn element_neighbours(&self, parent_id: u64, child: u64, from_end: bool) -> (Option<u64>, Option<u64>) {
        let Some(parent) = self.elements.get(&parent_id) else {
            return (None, None);
        };
        let position = if from_end {
            parent.children.iter().rposition(|id| *id == child)
        } else {
            parent.children.iter().position(|id| *id == child)
        };
        let Some(position) = position else {
            return (None, None);
        };
        let mut steps = 0;
        let before = parent.children[..position].iter().rev().copied().find(|id| {
            steps += 1;
            self.is_matchable_id(*id)
        });
        let after = parent.children[position + 1..].iter().copied().find(|id| {
            steps += 1;
            self.is_matchable_id(*id)
        });
        count_sibling_work(steps);
        (before, after)
    }

    fn note_range(&mut self, anchor: u64, inclusive: bool, after: bool) {
        let range = SiblingRange { anchor, inclusive, after };
        if self.sheets.ranges.last().is_some_and(|last| last.same_as(&range)) {
            return;
        }
        self.sheets.ranges.push(range);
    }

    /// Before `child` leaves `parent_id`: what stays is marked as it will be without it.
    pub(super) fn positions_unlinking(&mut self, child: u64, parent_id: u64) {
        let positional = self.sheets.index.invalidation.positional;
        if positional.is_empty() {
            return;
        }
        self.sheets.mark(parent_id, positional.empty);
        if !self.is_matchable_id(child) {
            return;
        }
        let wants_neighbours = !positional.edge.is_empty() || !positional.forward.is_empty() || !positional.backward.is_empty();
        if !wants_neighbours {
            return;
        }
        let (before, after) = self.element_neighbours(parent_id, child, false);
        if let Some(before) = before {
            self.sheets.mark(before, positional.edge);
            if !positional.backward.is_empty() {
                self.note_range(before, true, false);
            }
        }
        if let Some(after) = after {
            self.sheets.mark(after, positional.edge);
            if !positional.forward.is_empty() {
                self.note_range(after, true, true);
            }
        }
    }

    /// After `child` was put in `parent_id`.
    pub(super) fn positions_linked(&mut self, child: u64, parent_id: u64) {
        let positional = self.sheets.index.invalidation.positional;
        if positional.is_empty() {
            return;
        }
        self.sheets.mark(parent_id, positional.empty);
        if !self.is_matchable_id(child) {
            return;
        }
        if !positional.edge.is_empty() {
            let (before, after) = self.element_neighbours(parent_id, child, true);
            for neighbour in before.into_iter().chain(after) {
                self.sheets.mark(neighbour, positional.edge);
            }
        }
        if !positional.forward.is_empty() {
            self.note_range(child, false, true);
        }
        if !positional.backward.is_empty() {
            self.note_range(child, false, false);
        }
    }

    /// A text node's text became empty or stopped being: only `:empty` can tell.
    pub(super) fn positions_text_emptiness_changed(&mut self, text: u64) {
        let reach = self.sheets.index.invalidation.positional.empty;
        if reach.is_empty() || self.is_matchable_id(text) {
            return;
        }
        if let Some(parent) = self.elements.get(&text).and_then(|element| element.parent) {
            self.sheets.mark(parent, reach);
        }
    }

    /// The marks the noted ranges come to, for each element in them. One walk of a parent's
    /// children covers every range under it.
    pub(super) fn range_marks(&self, ranges: &[SiblingRange]) -> Vec<(u64, Reach)> {
        let positional = self.sheets.index.invalidation.positional;
        let mut by_parent: FxHashMap<u64, Vec<SiblingRange>> = FxHashMap::default();
        for range in ranges {
            if let Some(parent_id) = self.elements.get(&range.anchor).and_then(|element| element.parent) {
                by_parent.entry(parent_id).or_default().push(*range);
            }
        }
        // Per parent: the first position the forward ranges reach, and one past the last position
        // the backward ones do.
        let mut spans: FxHashMap<u64, (Option<usize>, Option<usize>)> = FxHashMap::default();
        for (parent_id, ranges) in by_parent {
            let Some(parent) = self.elements.get(&parent_id) else {
                continue;
            };
            count_sibling_work(parent.children.len());
            // Built children one by one, a list has a range for each, so a scan for each would be quadratic.
            let positions: FxHashMap<u64, usize> = if let [range] = &ranges[..] {
                parent.children.iter().position(|id| *id == range.anchor).map(|at| (range.anchor, at)).into_iter().collect()
            } else {
                parent.children.iter().enumerate().map(|(at, id)| (*id, at)).collect()
            };
            let span = spans.entry(parent_id).or_default();
            for range in ranges {
                let Some(position) = positions.get(&range.anchor).copied() else {
                    continue;
                };
                if range.after {
                    let start = position + usize::from(!range.inclusive);
                    span.0 = Some(span.0.map_or(start, |first| first.min(start)));
                } else {
                    let end = position + usize::from(range.inclusive);
                    span.1 = Some(span.1.map_or(end, |last| last.max(end)));
                }
            }
        }
        let mut marks = Vec::new();
        for (parent_id, (forward_from, backward_to)) in spans {
            let children = &self.elements[&parent_id].children;
            count_sibling_work(children.len());
            if let Some(start) = forward_from {
                marks.extend(self.matchable_marks(&children[start.min(children.len())..], positional.forward));
            }
            if let Some(end) = backward_to {
                marks.extend(self.matchable_marks(&children[..end.min(children.len())], positional.backward));
            }
        }
        marks
    }

    fn matchable_marks<'a>(&'a self, children: &'a [u64], reach: Reach) -> impl Iterator<Item = (u64, Reach)> + 'a {
        children.iter().filter(|id| self.is_matchable_id(**id)).map(move |id| (*id, reach))
    }
}
