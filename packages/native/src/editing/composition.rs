//! The text an input method has marked in an editing host.
//!
//! AppKit tells the handler to mark a stretch of text (`setMarkedText`) and asks for it back
//! (`markedRange`) until the composition ends. The offsets of a [`Snapshot`] are no good for keeping it:
//! the snapshot is made again after every edit, from wherever the selection is then. So the mark is kept
//! as DOM positions, a `#text` node and an offset for each end, and turned into snapshot offsets when it
//! is asked for, which is what lets it survive JS making the edit that put the marked text there.
//!
//! It lasts until the input method ends it (`insertText`, `unmarkText`, a mark of no text), and no longer
//! than the selection stays in it or the host keeps focus: a click that moves the caret out of the
//! composition leaves nothing marked, and a host that is focused again starts with no composition.

use std::cell::Cell;
use std::ops::Range;

use super::positions::DomPoint;
use super::snapshot::Snapshot;

/// The marked text: from `start` to `end`, in the editing host `host`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Marked {
    pub host: u64,
    pub start: DomPoint,
    pub end: DomPoint,
}

impl Marked {
    /// The marked range in `snapshot`, `None` when an end is in a `#text` node that is not in it, or
    /// when the range has turned over.
    fn range_in(&self, snapshot: &Snapshot) -> Option<Range<usize>> {
        let start = snapshot.offset_of(self.start)?;
        let end = snapshot.offset_of(self.end)?;
        (start <= end).then_some(start..end)
    }
}

/// What is marked in the tree: a `Cell` of a plain value, so that a focus change, which only reads the
/// tree, can end the composition.
#[derive(Debug, Default)]
pub struct Composition {
    marked: Cell<Option<Marked>>,
}

impl Composition {
    pub fn mark(&self, marked: Marked) {
        self.marked.set(Some(marked));
    }

    pub fn end(&self) {
        self.marked.set(None);
    }

    /// `element` lost focus: a composition in it is over.
    pub fn focus_left(&self, element: u64) {
        if self.marked.get().is_some_and(|marked| marked.host == element) {
            self.end();
        }
    }

    /// The marked range of `host` as offsets into `snapshot`, which is the snapshot of the selection now.
    /// A mark that is gone from the snapshot, is another host's or does not hold the selection is over, and
    /// is forgotten here.
    pub fn range(&self, host: u64, snapshot: Option<&Snapshot>) -> Option<Range<usize>> {
        let marked = self.marked.get()?;
        let range = snapshot
            .filter(|_| marked.host == host)
            .and_then(|snapshot| marked.range_in(snapshot).filter(|range| holds(range, &snapshot.selection())));
        if range.is_none() {
            self.end();
        }
        range
    }
}

/// Whether `selection` is in `marked`, an end of it at an edge of it included: the caret after the last
/// marked character is in the composition.
fn holds(marked: &Range<usize>, selection: &Range<usize>) -> bool {
    marked.start <= selection.start && selection.end <= marked.end
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editing::node_selection::{set, Boundary, Selection};
    use crate::retained_tree::RetainedTree;

    /// A host (1) with one paragraph (10) of text 11, and the caret in it.
    struct Fixture {
        tree: RetainedTree,
        composition: Composition,
    }

    impl Fixture {
        fn new(text: &str) -> Self {
            let mut tree = RetainedTree::new();
            tree.create_element(1, "div".to_string());
            tree.create_element(10, "div".to_string());
            tree.append_child(1, 10);
            tree.create_element(11, "#text".to_string());
            tree.set_text(11, text.to_string());
            tree.append_child(10, 11);
            Self { tree, composition: Composition::default() }
        }

        fn select(&mut self, from: usize, to: usize) {
            set(
                &mut self.tree,
                Some(Selection { anchor: Boundary { node: 11, offset: from }, focus: Boundary { node: 11, offset: to }, host: Some(1) }),
                false,
            );
        }

        fn marked(&self, start: usize, end: usize) -> Marked {
            Marked { host: 1, start: DomPoint { node: 11, offset: start }, end: DomPoint { node: 11, offset: end } }
        }

        fn range(&self) -> Option<Range<usize>> {
            let snapshot = Snapshot::of(&self.tree, 1);
            self.composition.range(1, snapshot.as_ref())
        }
    }

    #[test]
    fn the_mark_is_where_the_dom_positions_are_in_the_snapshot_made_after_the_edit() {
        let mut f = Fixture::new("ab");
        f.select(2, 2);
        f.composition.mark(f.marked(1, 2));
        assert_eq!(f.range(), Some(1..2));
        // JS edits the text: the composition grows by a character and the caret follows it.
        f.tree.set_text(11, "abc".to_string());
        f.composition.mark(f.marked(1, 3));
        f.select(3, 3);
        assert_eq!(f.range(), Some(1..3));
    }

    #[test]
    fn the_mark_follows_its_text_when_the_text_before_it_changes() {
        let mut f = Fixture::new("ab");
        f.select(2, 2);
        f.composition.mark(f.marked(1, 2));
        // The same positions of a longer data are other offsets of the same paragraph.
        f.tree.create_element(12, "#text".to_string());
        f.tree.set_text(12, "xyz".to_string());
        f.tree.insert_before(10, 12, 11);
        assert_eq!(f.range(), Some(4..5), "the snapshot has the text before it first");
    }

    #[test]
    fn a_caret_at_either_edge_or_a_selection_of_the_marked_text_is_in_it() {
        let mut f = Fixture::new("abcd");
        f.composition.mark(f.marked(1, 3));
        for (from, to) in [(1, 1), (3, 3), (2, 2), (1, 3)] {
            f.select(from, to);
            assert_eq!(f.range(), Some(1..3), "selection {from}..{to}");
            f.composition.mark(f.marked(1, 3));
        }
    }

    #[test]
    fn moving_the_selection_out_of_the_marked_text_ends_it_for_good() {
        let mut f = Fixture::new("abcd");
        f.composition.mark(f.marked(1, 3));
        f.select(0, 0);
        assert_eq!(f.range(), None);
        f.select(2, 2);
        assert_eq!(f.range(), None, "the caret coming back is no composition");
    }

    #[test]
    fn a_selection_wider_than_the_marked_text_is_not_in_it() {
        let mut f = Fixture::new("abcd");
        f.composition.mark(f.marked(1, 3));
        f.select(0, 3);
        assert_eq!(f.range(), None);
    }

    #[test]
    fn a_mark_whose_text_node_is_gone_is_over() {
        let mut f = Fixture::new("abcd");
        f.composition.mark(Marked { host: 1, start: DomPoint { node: 99, offset: 0 }, end: DomPoint { node: 99, offset: 2 } });
        f.select(1, 1);
        assert_eq!(f.range(), None);
    }

    #[test]
    fn another_hosts_mark_is_no_composition_here() {
        let mut f = Fixture::new("abcd");
        f.select(2, 2);
        f.composition.mark(Marked { host: 7, ..f.marked(1, 3) });
        assert_eq!(f.range(), None);
    }

    #[test]
    fn a_host_losing_focus_ends_its_composition_and_nobody_elses() {
        let mut f = Fixture::new("abcd");
        f.select(2, 2);
        f.composition.mark(f.marked(1, 3));
        f.composition.focus_left(2);
        assert_eq!(f.range(), Some(1..3));
        f.composition.focus_left(1);
        f.composition.mark(f.marked(1, 3));
        f.composition.focus_left(1);
        assert_eq!(f.range(), None);
    }

    #[test]
    fn no_snapshot_means_no_composition() {
        let f = Fixture::new("abcd");
        f.composition.mark(f.marked(1, 3));
        assert_eq!(f.composition.range(1, None), None);
    }
}
