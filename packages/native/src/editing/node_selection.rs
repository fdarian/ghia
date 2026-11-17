//! The node selection JS holds, as native paints it.
//!
//! JS sends the selection (`setNodeSelection`, last in a batch) as two DOM boundary points: a `#text`
//! node and a UTF-16 offset, or an element and a child index. The tree keeps it here, not in the
//! painted-text selection (`text::selection`, whose identity makes a whole frame), and works out which
//! paragraphs it covers. A paragraph asks for its wash range as it is built; a change marks exactly the
//! containers whose paint differs (`RetainedTree::mark_render_changed`), so a selection change is a
//! patch and not a frame built whole.

use std::ops::Range;

use gpui::WindowId;
use napi_derive::napi;
use rustc_hash::FxHashSet;

use super::geometry::{wash_rects, TextRect};
use super::positions::{self, DomPoint};
use crate::retained_tree::RetainedTree;
use crate::text::inline::{is_raw_text, Paragraph};

/// A DOM boundary point. `offset` counts UTF-16 code units of a `#text` node and children of an element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Boundary {
    pub node: u64,
    pub offset: usize,
}

/// What JS sent: where the selection starts and ends as the user made it, and the editing host that a
/// collapsed selection is the caret of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Selection {
    pub anchor: Boundary,
    pub focus: Boundary,
    pub host: Option<u64>,
}

/// The text a selection reaches, in document order. `end.offset` is `usize::MAX` where the selection
/// ends at an element and so takes all of the last text before it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Span {
    start: DomPoint,
    end: DomPoint,
}

/// What the selection paints, worked out from the tree.
#[derive(Debug, Default, PartialEq, Eq)]
struct Painted {
    /// `None` while the selection is collapsed or reaches no text.
    span: Option<Span>,
    /// The paragraphs (`Paragraph::container`, `Paragraph::index`) that the span reaches.
    covered: FxHashSet<(u64, usize)>,
    /// The two boundaries as sent, each with the container that holds it. An end that moves changes
    /// the paint of the paragraph it left and the one it came to, and of no other.
    ends: Vec<(Boundary, u64)>,
}

#[derive(Debug, Default)]
pub struct NodeSelection {
    selection: Option<Selection>,
    painted: Painted,
}

impl NodeSelection {
    /// The bytes of `paragraph` that the selection washes, if any.
    pub fn wash_range(&self, paragraph: &Paragraph) -> Option<Range<usize>> {
        let span = self.painted.span.as_ref()?;
        if !self.painted.covered.contains(&(paragraph.container, paragraph.index)) {
            return None;
        }
        let start = positions::byte_of(paragraph, span.start.node, span.start.offset).unwrap_or(0);
        let end = positions::byte_of(paragraph, span.end.node, span.end.offset).unwrap_or(paragraph.text.len());
        (start < end).then_some(start..end)
    }

    pub fn is_collapsed(&self) -> bool {
        self.painted.span.is_none()
    }

    pub fn is_set(&self) -> bool {
        self.selection.is_some()
    }
}

/// One paragraph's node-selection wash as the last painted frame drew it.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
pub struct PaintedWash {
    /// The paragraph, as `container:index`.
    pub key: String,
    /// The washed bytes of the paragraph text, as UTF-16 offsets into it.
    pub start: f64,
    pub end: f64,
    /// One box for each line the wash covers, in window coordinates.
    pub rects: Vec<TextRect>,
}

/// What the last painted frame washed for the node selection, in paint order: read from the texts the
/// frame registered, so a replay that kept a stale wash shows here as it does on screen.
pub fn painted(window: WindowId) -> Vec<PaintedWash> {
    let utf16 = |text: &str, byte: usize| text[..byte.min(text.len())].encode_utf16().count() as f64;
    crate::text::paint::node_washed(window)
        .into_iter()
        .flat_map(|entry| {
            entry
                .node_wash
                .iter()
                .map(|range| PaintedWash {
                    key: entry.key.to_string(),
                    start: utf16(&entry.text, range.start),
                    end: utf16(&entry.text, range.end),
                    rects: wash_rects(&entry, range),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The path of child indices from the top of the tree to `node`.
fn path_of(tree: &RetainedTree, node: u64) -> Option<Vec<usize>> {
    let mut path = Vec::new();
    let mut at = tree.elements.get(&node)?;
    while let Some(parent) = at.parent {
        let parent = tree.elements.get(&parent)?;
        path.push(parent.children.iter().position(|child| *child == at.id)?);
        at = parent;
    }
    path.reverse();
    Some(path)
}

/// Where a boundary is in tree order: the path of the node, then the offset. An element boundary
/// `(parent, i)` is before the child `i`, so it sorts before every position in that child.
fn order_key(tree: &RetainedTree, boundary: Boundary) -> Option<Vec<usize>> {
    let mut key = path_of(tree, boundary.node)?;
    key.push(boundary.offset);
    Some(key)
}

/// A walk over the `#text` nodes of the tree in order, from a boundary on.
struct Walk<'a> {
    tree: &'a RetainedTree,
    /// The elements being walked, outermost first, with the index of the child to visit next.
    stack: Vec<(u64, usize)>,
}

impl<'a> Walk<'a> {
    fn from(tree: &'a RetainedTree, boundary: Boundary) -> Option<Self> {
        let node = tree.elements.get(&boundary.node)?;
        let index_in = |parent: u64, child: u64| tree.elements.get(&parent)?.children.iter().position(|sibling| *sibling == child);
        let mut stack = Vec::new();
        let mut child = node.id;
        if is_raw_text(node) {
            // A text is visited itself, then what comes after it.
            let parent = node.parent?;
            stack.push((parent, index_in(parent, node.id)?));
            child = parent;
        } else {
            stack.push((node.id, boundary.offset.min(node.children.len())));
        }
        while let Some(parent) = tree.elements.get(&child)?.parent {
            stack.push((parent, index_in(parent, child)? + 1));
            child = parent;
        }
        stack.reverse();
        Some(Self { tree, stack })
    }

    /// The next text, unless the walk is at `stop`, an element boundary.
    fn next_text(&mut self, stop: Option<Boundary>) -> Option<u64> {
        loop {
            let (element, next) = *self.stack.last()?;
            if stop.is_some_and(|stop| stop.node == element && stop.offset == next) {
                return None;
            }
            let children = &self.tree.elements.get(&element)?.children;
            let Some(&child) = children.get(next) else {
                self.stack.pop();
                continue;
            };
            self.stack.last_mut()?.1 += 1;
            let child_element = self.tree.elements.get(&child)?;
            if is_raw_text(child_element) {
                return Some(child);
            }
            self.stack.push((child, 0));
        }
    }
}

/// The container that paints `node` if it is a text, or `node` itself.
fn container_of(tree: &RetainedTree, boundary: Boundary) -> Option<u64> {
    let element = tree.elements.get(&boundary.node)?;
    if is_raw_text(element) {
        return positions::locate(tree, boundary.node).map(|located| located.paragraph().container);
    }
    Some(element.id)
}

fn paint_of(tree: &RetainedTree, selection: &Selection) -> Painted {
    let ends: Vec<(Boundary, u64)> = [selection.anchor, selection.focus]
        .into_iter()
        .filter_map(|boundary| Some((boundary, container_of(tree, boundary)?)))
        .collect();
    let (Some(anchor), Some(focus)) = (order_key(tree, selection.anchor), order_key(tree, selection.focus)) else {
        return Painted { ends, ..Painted::default() };
    };
    if anchor == focus {
        return Painted { ends, ..Painted::default() };
    }
    let (start, end) = if anchor <= focus { (selection.anchor, selection.focus) } else { (selection.focus, selection.anchor) };
    let Some(mut walk) = Walk::from(tree, start) else {
        return Painted { ends, ..Painted::default() };
    };
    let end_text = tree.elements.get(&end.node).is_some_and(is_raw_text);
    let stop = (!end_text).then_some(end);
    let mut covered = FxHashSet::default();
    let mut first = None;
    let mut last = None;
    while let Some(text) = walk.next_text(stop) {
        if let Some(located) = positions::locate(tree, text) {
            let paragraph = located.paragraph();
            covered.insert((paragraph.container, paragraph.index));
            first.get_or_insert(text);
            last = Some(text);
        }
        if end_text && text == end.node {
            break;
        }
    }
    let (Some(first), Some(last)) = (first, last) else {
        return Painted { ends, ..Painted::default() };
    };
    let start_point = if tree.elements.get(&start.node).is_some_and(is_raw_text) {
        DomPoint { node: start.node, offset: start.offset }
    } else {
        DomPoint { node: first, offset: 0 }
    };
    let end_point = if end_text { DomPoint { node: end.node, offset: end.offset } } else { DomPoint { node: last, offset: usize::MAX } };
    Painted { span: Some(Span { start: start_point, end: end_point }), covered, ends }
}

/// The containers whose paint differs between two states: those of paragraphs covered by one and not
/// the other, and those that hold a boundary that only one of them has.
fn changed_containers(before: &Painted, after: &Painted) -> Vec<u64> {
    let only_in = |from: &Painted, other: &Painted| {
        from.ends.iter().filter(|end| !other.ends.contains(end)).map(|(_, container)| *container).collect::<Vec<_>>()
    };
    let mut changed: Vec<u64> = before
        .covered
        .symmetric_difference(&after.covered)
        .map(|(container, _)| *container)
        .chain(only_in(before, after))
        .chain(only_in(after, before))
        .collect();
    changed.sort_unstable();
    changed.dedup();
    changed
}

fn update(tree: &mut RetainedTree, state: &mut NodeSelection) {
    let next = state.selection.as_ref().map(|selection| paint_of(tree, selection)).unwrap_or_default();
    if next == state.painted {
        return;
    }
    let changed = changed_containers(&state.painted, &next);
    state.painted = next;
    for id in changed {
        if tree.elements.contains_key(&id) {
            tree.mark_render_changed(id);
        }
    }
}

/// `setNodeSelection`: the selection JS holds in this tree's root, or `None` when it left it.
pub fn set(tree: &mut RetainedTree, selection: Option<Selection>) {
    let mut state = std::mem::take(&mut tree.node_selection);
    state.selection = selection;
    update(tree, &mut state);
    tree.node_selection = state;
}

/// After a batch changed the shape of the tree or a text: a selection that spans paragraphs reaches
/// the ones that are there now.
pub fn refresh(tree: &mut RetainedTree) {
    if tree.node_selection.selection.is_none() || tree.node_selection.is_collapsed() {
        return;
    }
    let mut state = std::mem::take(&mut tree.node_selection);
    update(tree, &mut state);
    tree.node_selection = state;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        tree: RetainedTree,
    }

    impl Fixture {
        fn new() -> Self {
            let mut tree = RetainedTree::new();
            tree.create_element(1, "div".to_string());
            Self { tree }
        }

        fn add(&mut self, parent: u64, id: u64, kind: &str) -> &mut Self {
            self.tree.create_element(id, kind.to_string());
            self.tree.append_child(parent, id);
            self
        }

        fn text(&mut self, parent: u64, id: u64, content: &str) -> &mut Self {
            self.add(parent, id, "#text");
            self.tree.set_text(id, content.to_string());
            self
        }

        /// A host (1) with a paragraph `<p>` (10, 20, 30) for each text (11, 21, 31).
        fn paragraphs(lines: &[&str]) -> Self {
            let mut f = Self::new();
            for (index, line) in lines.iter().enumerate() {
                let p = 10 * (index as u64 + 1);
                f.add(1, p, "div").text(p, p + 1, line);
            }
            f
        }

        fn select(&mut self, anchor: (u64, usize), focus: (u64, usize)) {
            set(
                &mut self.tree,
                Some(Selection {
                    anchor: Boundary { node: anchor.0, offset: anchor.1 },
                    focus: Boundary { node: focus.0, offset: focus.1 },
                    host: None,
                }),
            );
        }

        fn clear(&mut self) {
            set(&mut self.tree, None);
        }

        fn covered(&self) -> Vec<u64> {
            let mut containers: Vec<u64> = self.tree.node_selection.painted.covered.iter().map(|(container, _)| *container).collect();
            containers.sort_unstable();
            containers
        }

        fn wash(&self, container: u64) -> Option<Range<usize>> {
            let planned = crate::text::plan_cache::planned(&self.tree, &self.tree.elements[&container]);
            let paragraph = positions::paragraphs_of(&planned).first().map(|paragraph| (*paragraph).clone()).expect("a paragraph");
            self.tree.node_selection.wash_range(&paragraph)
        }

        /// The revision of an element: what `mark_render_changed` moves.
        fn revision(&self, id: u64) -> u64 {
            self.tree.elements[&id].subtree_revision
        }
    }

    #[test]
    fn a_selection_across_paragraphs_covers_them_and_washes_the_ends_from_the_points() {
        let mut f = Fixture::paragraphs(&["first line", "second", "third line"]);
        f.select((11, 6), (31, 5));
        assert_eq!(f.covered(), vec![10, 20, 30]);
        assert_eq!(f.wash(10), Some(6..10));
        assert_eq!(f.wash(20), Some(0..6));
        assert_eq!(f.wash(30), Some(0..5));
    }

    #[test]
    fn a_backwards_selection_is_the_same_span() {
        let mut f = Fixture::paragraphs(&["first line", "second"]);
        f.select((21, 3), (11, 2));
        assert_eq!(f.wash(10), Some(2..10));
        assert_eq!(f.wash(20), Some(0..3));
    }

    #[test]
    fn a_selection_inside_one_paragraph_washes_between_the_points() {
        let mut f = Fixture::paragraphs(&["abcdef", "other"]);
        f.select((11, 1), (11, 4));
        assert_eq!(f.covered(), vec![10]);
        assert_eq!(f.wash(10), Some(1..4));
        assert_eq!(f.wash(20), None);
    }

    #[test]
    fn a_collapsed_selection_washes_nothing() {
        let mut f = Fixture::paragraphs(&["abcdef", "other"]);
        f.select((11, 3), (11, 3));
        assert!(f.covered().is_empty());
        assert_eq!(f.wash(10), None);
    }

    #[test]
    fn element_boundaries_reach_the_text_next_to_them() {
        let mut f = Fixture::paragraphs(&["one", "two", "three"]);
        // From before the second paragraph to before the third: only the second is covered, whole.
        f.select((1, 1), (1, 2));
        assert_eq!(f.covered(), vec![20]);
        assert_eq!(f.wash(20), Some(0..3));
        // To the end of the host: the second and the third.
        f.select((1, 1), (1, 3));
        assert_eq!(f.covered(), vec![20, 30]);
        assert_eq!(f.wash(30), Some(0..5));
    }

    #[test]
    fn an_end_at_an_element_inside_a_paragraph_stops_where_the_element_is() {
        let mut f = Fixture::new();
        f.add(1, 10, "div").text(10, 11, "ab").add(10, 12, "span").text(12, 13, "cd").text(10, 14, "ef");
        // From the start of "ab" to before "ef": "abcd".
        f.select((11, 0), (10, 2));
        assert_eq!(f.wash(10), Some(0..4));
    }

    #[test]
    fn moving_the_selection_marks_the_paragraphs_that_paint_differently_and_no_others() {
        let mut f = Fixture::paragraphs(&["aaaa", "bbbb", "cccc", "dddd", "eeee"]);
        let before: Vec<u64> = [10, 20, 30, 40, 50].iter().map(|id| f.revision(*id)).collect();
        f.select((21, 1), (31, 2));
        let selected: Vec<u64> = [10, 20, 30, 40, 50].iter().map(|id| f.revision(*id)).collect();
        assert_eq!(
            [10, 20, 30, 40, 50].iter().zip(before.iter().zip(&selected)).filter(|(_, (before, after))| before != after).map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![20, 30]
        );
        // The focus moves on in the third paragraph and then into the fourth: the third, which holds an end,
        // is marked; the second, which is still covered whole from the same point, is not.
        let second = f.revision(20);
        f.select((21, 1), (41, 1));
        assert_eq!(f.revision(20), second, "a paragraph that is covered before and after, with no end in it, is left as it is");
        assert_ne!(f.revision(40), selected[3]);
    }

    #[test]
    fn collapsing_the_selection_marks_what_it_covered() {
        let mut f = Fixture::paragraphs(&["aaaa", "bbbb", "cccc"]);
        f.select((11, 1), (31, 2));
        let middle = f.revision(20);
        f.select((11, 1), (11, 1));
        assert_ne!(f.revision(20), middle, "the middle paragraph lost its wash");
        assert!(f.covered().is_empty());
    }

    #[test]
    fn a_selection_that_changes_nothing_marks_nothing() {
        let mut f = Fixture::paragraphs(&["aaaa", "bbbb"]);
        f.select((11, 1), (21, 2));
        let revisions: Vec<u64> = [10, 20].iter().map(|id| f.revision(*id)).collect();
        f.select((11, 1), (21, 2));
        assert_eq!([10, 20].iter().map(|id| f.revision(*id)).collect::<Vec<_>>(), revisions);
    }

    #[test]
    fn clearing_it_marks_the_paragraphs_it_covered() {
        let mut f = Fixture::paragraphs(&["aaaa", "bbbb", "cccc"]);
        f.select((11, 1), (31, 2));
        let middle = f.revision(20);
        f.clear();
        assert_ne!(f.revision(20), middle);
        assert_eq!(f.wash(20), None);
    }

    #[test]
    fn a_paragraph_added_inside_the_selection_is_covered_after_a_refresh() {
        let mut f = Fixture::paragraphs(&["aaaa", "cccc"]);
        f.select((11, 1), (21, 2));
        assert_eq!(f.covered(), vec![10, 20]);
        // Between the two, where the selection passes.
        f.tree.create_element(15, "div".to_string());
        f.tree.create_element(16, "#text".to_string());
        f.tree.set_text(16, "bbbb".to_string());
        f.tree.append_child(15, 16);
        f.tree.insert_before(1, 15, 20);
        refresh(&mut f.tree);
        assert_eq!(f.covered(), vec![10, 15, 20]);
        assert_eq!(f.wash(15), Some(0..4));
    }

    #[test]
    fn a_boundary_that_is_not_in_the_tree_paints_nothing() {
        let mut f = Fixture::paragraphs(&["aaaa"]);
        f.select((11, 1), (999, 0));
        assert!(f.covered().is_empty());
        assert_eq!(f.wash(10), None);
    }
}
