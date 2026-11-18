//! The document the platform's text input is told about while an editing host has focus.
//!
//! AppKit asks for the selection, for text around it and, with each edit, in which range to put the
//! text, all in UTF-16 offsets of one string. A host has no such string (its text is spread over
//! `#text` nodes in blocks), so one is made from what the node selection reaches: the `data` of the
//! `#text` nodes of every paragraph from the one the selection starts in to the one it ends in, joined by
//! a line feed between paragraphs. A `<br>` or an atomic inline has no character in it. The offsets in it
//! and the DOM positions go both ways through the segments, one for each `#text` node.
//!
//! It is read from the tree and the node selection JS last sent, and made again on every query: JS flushes
//! the mutations of an edit before it returns, so the next query sees them.

use std::ops::Range;

use super::node_selection::{order_key, Boundary, Walk};
use super::positions::{self, DomPoint};
use crate::retained_tree::RetainedTree;
use crate::text::inline::is_raw_text;

/// One `#text` node in the snapshot: its `data` is the `units` UTF-16 code units from `start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Segment {
    node: u64,
    start: usize,
    units: usize,
}

impl Segment {
    fn end(&self) -> usize {
        self.start + self.units
    }
}

/// Which of two segments that meet an offset belongs to: the start of a range sits at the start of the
/// text after it, and the end of a range at the end of the text before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Start,
    End,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    text: String,
    segments: Vec<Segment>,
    selection: Range<usize>,
    reversed: bool,
}

fn units_of(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn within(tree: &RetainedTree, node: u64, host: u64) -> bool {
    std::iter::successors(Some(node), |id| tree.elements.get(id).and_then(|element| element.parent)).any(|id| id == host)
}

/// The paragraph that paints `node`, as the key that tells paragraphs apart and the `#text` nodes it holds.
fn paragraph_texts(tree: &RetainedTree, node: u64) -> Option<((u64, usize), Vec<u64>)> {
    let located = positions::locate(tree, node)?;
    let paragraph = located.paragraph();
    let texts = paragraph.pieces.iter().filter_map(|piece| piece.text.as_ref().map(|source| source.node)).collect();
    Some(((paragraph.container, paragraph.index), texts))
}

impl Snapshot {
    /// The snapshot for `host`, or `None` when the node selection is not in it: no selection, or one whose
    /// ends are in something else.
    pub fn of(tree: &RetainedTree, host: u64) -> Option<Self> {
        let selection = tree.node_selection.selection()?;
        let collapsed = selection.anchor == selection.focus;
        let inside = if collapsed { selection.host == Some(host) } else { within(tree, selection.anchor.node, host) && within(tree, selection.focus.node, host) };
        if !inside {
            return None;
        }
        let reversed = !collapsed && order_key(tree, selection.anchor) > order_key(tree, selection.focus);
        let reach = match tree.node_selection.reach() {
            Some(reach) => Some(reach),
            None if collapsed && tree.elements.get(&selection.focus.node).is_some_and(is_raw_text) => {
                let point = DomPoint { node: selection.focus.node, offset: selection.focus.offset };
                Some((point, point))
            }
            None => None,
        };
        let Some((start, end)) = reach else {
            return Some(Self { text: String::new(), segments: Vec::new(), selection: 0..0, reversed: false });
        };
        let mut paragraphs: Vec<((u64, usize), Vec<u64>)> = Vec::new();
        let mut walk = Walk::from(tree, Boundary { node: start.node, offset: start.offset })?;
        while let Some(text) = walk.next_text(None) {
            if let Some((key, texts)) = paragraph_texts(tree, text) {
                if paragraphs.last().is_none_or(|(last, _)| *last != key) {
                    paragraphs.push((key, texts));
                }
            }
            if text == end.node {
                break;
            }
        }
        let mut snapshot = Self { text: String::new(), segments: Vec::new(), selection: 0..0, reversed };
        for (index, (_, texts)) in paragraphs.iter().enumerate() {
            if index > 0 {
                snapshot.text.push('\n');
            }
            for node in texts {
                let data = tree.elements.get(node).and_then(|element| element.content.as_deref()).unwrap_or_default();
                let start = units_of(&snapshot.text);
                snapshot.segments.push(Segment { node: *node, start, units: units_of(data) });
                snapshot.text.push_str(data);
            }
        }
        let from = snapshot.offset_of(start)?;
        let to = snapshot.offset_of(end)?;
        snapshot.selection = from..to;
        Some(snapshot)
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn len(&self) -> usize {
        units_of(&self.text)
    }

    pub fn selection(&self) -> Range<usize> {
        self.selection.clone()
    }

    pub fn is_reversed(&self) -> bool {
        self.reversed
    }

    /// The snapshot offset of a DOM position, `None` when its node is not in the snapshot. An offset
    /// past the data is its end, which is what `usize::MAX` stands for.
    pub fn offset_of(&self, point: DomPoint) -> Option<usize> {
        let segment = self.segments.iter().find(|segment| segment.node == point.node)?;
        Some(segment.start + point.offset.min(segment.units))
    }

    /// The DOM position of a snapshot offset, in the text that starts at it for the start of a range and
    /// in the text that ends at it for the end. `None` past the end of the snapshot or when it holds no
    /// text node.
    pub fn point_at(&self, offset: usize, edge: Edge) -> Option<DomPoint> {
        let contains = |segment: &&Segment| match edge {
            Edge::Start => segment.start <= offset && offset < segment.end(),
            Edge::End => segment.start < offset && offset <= segment.end(),
        };
        let touches = |segment: &&Segment| match edge {
            Edge::Start => segment.end() == offset,
            Edge::End => segment.start == offset,
        };
        let segment = self.segments.iter().find(contains).or_else(|| self.segments.iter().rev().find(touches))?;
        Some(DomPoint { node: segment.node, offset: offset - segment.start })
    }

    /// The DOM positions of a range of offsets: its start and its end.
    pub fn dom_range(&self, range: &Range<usize>) -> Option<(DomPoint, DomPoint)> {
        if range.start > range.end || range.end > self.len() {
            return None;
        }
        Some((self.point_at(range.start, Edge::Start)?, self.point_at(range.end, Edge::End)?))
    }

    /// The text of a range of offsets, cut at characters when it ends inside a surrogate pair.
    pub fn text_in(&self, range: &Range<usize>) -> String {
        let mut seen = 0;
        let mut out = String::new();
        for c in self.text.chars() {
            let next = seen + c.len_utf16();
            if seen >= range.start && next <= range.end {
                out.push(c);
            }
            seen = next;
            if seen >= range.end {
                break;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editing::node_selection::{set, Selection};

    struct Fixture {
        tree: RetainedTree,
    }

    impl Fixture {
        /// A host (1) with a paragraph (10, 20, 30) for each line, its text 11, 21, 31.
        fn paragraphs(lines: &[&str]) -> Self {
            let mut tree = RetainedTree::new();
            tree.create_element(1, "div".to_string());
            for (index, line) in lines.iter().enumerate() {
                let p = 10 * (index as u64 + 1);
                tree.create_element(p, "div".to_string());
                tree.append_child(1, p);
                tree.create_element(p + 1, "#text".to_string());
                tree.set_text(p + 1, line.to_string());
                tree.append_child(p, p + 1);
            }
            Self { tree }
        }

        fn select(&mut self, anchor: (u64, usize), focus: (u64, usize), host: Option<u64>) {
            set(
                &mut self.tree,
                Some(Selection {
                    anchor: Boundary { node: anchor.0, offset: anchor.1 },
                    focus: Boundary { node: focus.0, offset: focus.1 },
                    host,
                }),
                false,
            );
        }

        fn snapshot(&self) -> Option<Snapshot> {
            Snapshot::of(&self.tree, 1)
        }
    }

    #[test]
    fn a_caret_is_the_text_of_its_paragraph_with_the_selection_at_it() {
        let mut f = Fixture::paragraphs(&["first", "second", "third"]);
        f.select((21, 3), (21, 3), Some(1));
        let snapshot = f.snapshot().expect("a snapshot");
        assert_eq!(snapshot.text(), "second");
        assert_eq!(snapshot.selection(), 3..3);
    }

    #[test]
    fn a_selection_across_paragraphs_joins_them_with_a_line_feed() {
        let mut f = Fixture::paragraphs(&["first", "second", "third"]);
        f.select((11, 2), (31, 1), None);
        let snapshot = f.snapshot().expect("a snapshot");
        assert_eq!(snapshot.text(), "first\nsecond\nthird");
        assert_eq!(snapshot.selection(), 2..14);
        assert!(!snapshot.is_reversed());
    }

    #[test]
    fn a_backwards_selection_is_the_same_range_reversed() {
        let mut f = Fixture::paragraphs(&["first", "second"]);
        f.select((21, 1), (11, 2), None);
        let snapshot = f.snapshot().expect("a snapshot");
        assert_eq!(snapshot.selection(), 2..7);
        assert!(snapshot.is_reversed());
    }

    #[test]
    fn the_text_nodes_of_a_paragraph_are_one_run_of_text() {
        let mut f = Fixture::paragraphs(&["ab"]);
        f.tree.create_element(12, "span".to_string());
        f.tree.append_child(10, 12);
        f.tree.create_element(13, "#text".to_string());
        f.tree.set_text(13, "cd".to_string());
        f.tree.append_child(12, 13);
        f.select((13, 1), (13, 1), Some(1));
        let snapshot = f.snapshot().expect("a snapshot");
        assert_eq!(snapshot.text(), "abcd");
        assert_eq!(snapshot.selection(), 3..3);
    }

    #[test]
    fn an_offset_is_in_the_text_after_it_for_a_start_and_the_text_before_it_for_an_end() {
        let mut f = Fixture::paragraphs(&["ab"]);
        f.tree.create_element(12, "span".to_string());
        f.tree.append_child(10, 12);
        f.tree.create_element(13, "#text".to_string());
        f.tree.set_text(13, "cd".to_string());
        f.tree.append_child(12, 13);
        f.select((11, 1), (11, 1), Some(1));
        let snapshot = f.snapshot().expect("a snapshot");
        assert_eq!(snapshot.point_at(2, Edge::Start), Some(DomPoint { node: 13, offset: 0 }));
        assert_eq!(snapshot.point_at(2, Edge::End), Some(DomPoint { node: 11, offset: 2 }));
        assert_eq!(snapshot.dom_range(&(1..3)), Some((DomPoint { node: 11, offset: 1 }, DomPoint { node: 13, offset: 1 })));
        assert_eq!(snapshot.dom_range(&(4..4)), Some((DomPoint { node: 13, offset: 2 }, DomPoint { node: 13, offset: 2 })));
        assert_eq!(snapshot.dom_range(&(0..0)), Some((DomPoint { node: 11, offset: 0 }, DomPoint { node: 11, offset: 0 })));
    }

    #[test]
    fn offsets_across_a_paragraph_break_land_at_the_end_of_one_and_the_start_of_the_next() {
        let mut f = Fixture::paragraphs(&["ab", "cd"]);
        f.select((11, 0), (21, 2), None);
        let snapshot = f.snapshot().expect("a snapshot");
        assert_eq!(snapshot.text(), "ab\ncd");
        assert_eq!(snapshot.point_at(2, Edge::Start), Some(DomPoint { node: 11, offset: 2 }));
        assert_eq!(snapshot.point_at(3, Edge::Start), Some(DomPoint { node: 21, offset: 0 }));
        assert_eq!(snapshot.point_at(3, Edge::End), Some(DomPoint { node: 21, offset: 0 }));
        assert_eq!(snapshot.dom_range(&(1..4)), Some((DomPoint { node: 11, offset: 1 }, DomPoint { node: 21, offset: 1 })));
    }

    #[test]
    fn a_dom_position_is_an_offset_and_back() {
        let mut f = Fixture::paragraphs(&["ab", "cd"]);
        f.select((11, 0), (21, 2), None);
        let snapshot = f.snapshot().expect("a snapshot");
        assert_eq!(snapshot.offset_of(DomPoint { node: 21, offset: 1 }), Some(4));
        assert_eq!(snapshot.offset_of(DomPoint { node: 21, offset: usize::MAX }), Some(5));
        assert_eq!(snapshot.offset_of(DomPoint { node: 99, offset: 0 }), None);
    }

    #[test]
    fn offsets_count_utf16_code_units() {
        let mut f = Fixture::paragraphs(&["a😀b"]);
        f.select((11, 3), (11, 3), Some(1));
        let snapshot = f.snapshot().expect("a snapshot");
        assert_eq!(snapshot.len(), 4);
        assert_eq!(snapshot.selection(), 3..3);
        assert_eq!(snapshot.text_in(&(1..3)), "😀");
        assert_eq!(snapshot.text_in(&(1..2)), "", "half of a surrogate pair is no text");
        assert_eq!(snapshot.text_in(&(0..9)), "a😀b");
        assert_eq!(snapshot.dom_range(&(1..3)), Some((DomPoint { node: 11, offset: 1 }, DomPoint { node: 11, offset: 3 })));
    }

    #[test]
    fn a_range_outside_the_snapshot_has_no_position() {
        let mut f = Fixture::paragraphs(&["ab"]);
        f.select((11, 1), (11, 1), Some(1));
        let snapshot = f.snapshot().expect("a snapshot");
        assert_eq!(snapshot.dom_range(&(1..9)), None);
        assert_eq!(snapshot.dom_range(&(2..1)), None);
    }

    #[test]
    fn a_caret_at_an_element_is_an_empty_snapshot() {
        let mut f = Fixture::paragraphs(&["ab"]);
        f.tree.create_element(20, "div".to_string());
        f.tree.append_child(1, 20);
        f.select((20, 0), (20, 0), Some(1));
        let snapshot = f.snapshot().expect("a snapshot");
        assert_eq!(snapshot.text(), "");
        assert_eq!(snapshot.selection(), 0..0);
    }

    #[test]
    fn a_selection_in_another_host_or_none_has_no_snapshot() {
        let mut f = Fixture::paragraphs(&["ab"]);
        assert_eq!(f.snapshot(), None);
        f.select((11, 1), (11, 1), Some(7));
        assert_eq!(f.snapshot(), None);
        f.select((11, 0), (11, 1), None);
        assert!(f.snapshot().is_some());
        assert_eq!(Snapshot::of(&f.tree, 7), None);
    }
}
