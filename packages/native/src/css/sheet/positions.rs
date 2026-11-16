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

use rustc_hash::{FxHashMap, FxHashSet};

use crate::retained_tree::{RetainedElement, RetainedTree};

use super::invalidation::Reach;
use super::view::count_sibling_work;

/// What the elements of a range are marked with.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum RangeMarks {
    /// What the counting pseudo-classes read on the side of the range, for every element sibling.
    Counting,
    /// The `:has()` anchors among them, the ones that hold what their compound requires.
    Anchors(Reach),
}

/// The children of `parent` from `anchor`, from it (when `inclusive`) to the end of the list when
/// `after`, or to the start when not, as the list stands at the flush. An anchor that is no longer
/// a child of `parent` (it moved or is gone, and may have been what told the siblings apart)
/// leaves the whole list, as does none.
///
/// What an element that moves between the note and the flush does to the run depends on the kind.
/// A `Counting` run needs nothing: the element that moves has marked itself, so the siblings on
/// its side of the anchor that stay are covered by the final positions. An `Anchors` run is
/// filtered by what an element holds, so an element that moves without the features of the
/// subject noted nothing, and one the run is keyed on takes the run's end with it: the anchor
/// leaving widens the run to the whole list ([`PendingRanges::anchor_leaving`]).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct SiblingRange {
    parent: u64,
    anchor: Option<u64>,
    inclusive: bool,
    after: bool,
    marks: RangeMarks,
}

impl SiblingRange {
    fn counting(parent: u64, anchor: u64, inclusive: bool, after: bool) -> SiblingRange {
        SiblingRange { parent, anchor: Some(anchor), inclusive, after, marks: RangeMarks::Counting }
    }

    /// The `:has()` anchors among the children of `parent` before `anchor`, not including it.
    pub(super) fn anchors_before(parent: u64, anchor: Option<u64>, reach: Reach) -> SiblingRange {
        SiblingRange { parent, anchor, inclusive: false, after: false, marks: RangeMarks::Anchors(reach) }
    }

    /// The `:has()` anchors among every child of `parent`.
    pub(super) fn anchors_among_children(parent: u64, reach: Reach) -> SiblingRange {
        SiblingRange { parent, anchor: None, inclusive: true, after: true, marks: RangeMarks::Anchors(reach) }
    }
}

/// The ranges noted since the last flush, each once.
#[derive(Default)]
pub(crate) struct PendingRanges {
    list: Vec<SiblingRange>,
    seen: FxHashSet<SiblingRange>,
    /// The elements an `Anchors` range is keyed on.
    anchored_on: FxHashSet<u64>,
}

impl PendingRanges {
    pub(crate) fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.list.len()
    }

    pub(super) fn note(&mut self, range: SiblingRange) {
        if !self.seen.insert(range) {
            return;
        }
        if let (RangeMarks::Anchors(_), Some(anchor)) = (range.marks, range.anchor) {
            self.anchored_on.insert(anchor);
        }
        self.list.push(range);
    }

    pub(super) fn take(&mut self) -> Vec<SiblingRange> {
        self.seen.clear();
        self.anchored_on.clear();
        std::mem::take(&mut self.list)
    }

    /// `child` is about to leave its place: an `Anchors` range keyed on it would be resolved
    /// against where it is at the flush, which can be before the siblings it was noted for.
    pub(super) fn anchor_leaving(&mut self, child: u64) {
        if !self.anchored_on.remove(&child) {
            return;
        }
        for at in 0..self.list.len() {
            let range = self.list[at];
            if range.anchor != Some(child) || !matches!(range.marks, RangeMarks::Anchors(_)) {
                continue;
            }
            let widened = SiblingRange { anchor: None, inclusive: true, ..range };
            self.list[at] = widened;
            self.seen.insert(widened);
        }
    }
}

impl RetainedTree {
    pub(super) fn is_matchable_id(&self, id: u64) -> bool {
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

    pub(super) fn note_range(&mut self, range: SiblingRange) {
        self.sheets.ranges.note(range);
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
                self.note_range(SiblingRange::counting(parent_id, before, true, false));
            }
        }
        if let Some(after) = after {
            self.sheets.mark(after, positional.edge);
            if !positional.forward.is_empty() {
                self.note_range(SiblingRange::counting(parent_id, after, true, true));
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
            self.note_range(SiblingRange::counting(parent_id, child, false, true));
        }
        if !positional.backward.is_empty() {
            self.note_range(SiblingRange::counting(parent_id, child, false, false));
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
        let mut by_parent: FxHashMap<u64, Vec<&SiblingRange>> = FxHashMap::default();
        for range in ranges {
            by_parent.entry(range.parent).or_default().push(range);
        }
        let mut marks = Vec::new();
        for (parent_id, ranges) in by_parent {
            let Some(parent) = self.elements.get(&parent_id) else {
                continue;
            };
            let children = &parent.children;
            count_sibling_work(children.len());
            let anchors: Vec<u64> = ranges.iter().filter_map(|range| range.anchor).collect();
            // Built children one by one, a list has a range for each, so a scan for each would be quadratic.
            let positions: FxHashMap<u64, usize> = match &anchors[..] {
                [] => FxHashMap::default(),
                [only] => children.iter().position(|id| id == only).map(|at| (*only, at)).into_iter().collect(),
                _ => children.iter().enumerate().map(|(at, id)| (*id, at)).collect(),
            };
            // Per kind of mark: the first position the forward ranges reach, and one past the last
            // position the backward ones do.
            let mut spans: Vec<(RangeMarks, Option<usize>, Option<usize>)> = Vec::new();
            for range in ranges {
                let position = range.anchor.and_then(|anchor| positions.get(&anchor).copied());
                let at = match spans.iter().position(|(kind, ..)| *kind == range.marks) {
                    Some(at) => at,
                    None => {
                        spans.push((range.marks, None, None));
                        spans.len() - 1
                    }
                };
                let (_, forward_from, backward_to) = &mut spans[at];
                if range.after {
                    let start = position.map_or(0, |position| position + usize::from(!range.inclusive));
                    *forward_from = Some(forward_from.map_or(start, |first| first.min(start)));
                } else {
                    let end = position.map_or(children.len(), |position| position + usize::from(range.inclusive));
                    *backward_to = Some(backward_to.map_or(end, |last| last.max(end)));
                }
            }
            for (kind, forward_from, backward_to) in spans {
                if let Some(start) = forward_from {
                    let reach = match kind {
                        RangeMarks::Counting => positional.forward,
                        RangeMarks::Anchors(reach) => reach,
                    };
                    marks.extend(self.range_elements(&children[start.min(children.len())..], kind, reach));
                }
                if let Some(end) = backward_to {
                    let reach = match kind {
                        RangeMarks::Counting => positional.backward,
                        RangeMarks::Anchors(reach) => reach,
                    };
                    marks.extend(self.range_elements(&children[..end.min(children.len())], kind, reach));
                }
            }
        }
        marks
    }

    fn range_elements<'a>(&'a self, children: &'a [u64], kind: RangeMarks, reach: Reach) -> impl Iterator<Item = (u64, Reach)> + 'a {
        children
            .iter()
            .filter(move |id| match kind {
                RangeMarks::Counting => self.is_matchable_id(**id),
                RangeMarks::Anchors(_) => self.holds_anchor_key(**id),
            })
            .map(move |id| (*id, reach))
    }
}
