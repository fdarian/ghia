//! DOM positions and the text a paragraph paints.
//!
//! A DOM position is a `#text` node and a UTF-16 offset in its `data`. The paragraph that paints the
//! node holds its text after `white-space` (`text::inline`): collapsed spaces are gone, `\r\n` is one
//! line feed, and a space cut off the end of a line is gone from the pieces before. Every character
//! that is kept came from exactly one character of the data (`\t` and `\n` become a space, `\r` a
//! line feed), so the way between them is a list of [`Run`]s: stretches kept in the same order with
//! nothing dropped inside. Text that collapses nothing is one run.

use std::ops::Range;
use std::sync::Arc;

use crate::retained_tree::{RetainedElement, RetainedTree};
use crate::text::inline::{Child, Paragraph, Piece};
use crate::text::plan_cache::{self, Planned};

/// A stretch of `Text.data` that the paragraph kept as it came: `units` UTF-16 code units from
/// `source`, painted as the `len` bytes from `byte` of the paragraph text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Run {
    pub source: u32,
    pub units: u32,
    pub byte: u32,
    pub len: u32,
}

impl Run {
    fn byte_end(&self) -> usize {
        (self.byte + self.len) as usize
    }

    fn source_end(&self) -> usize {
        (self.source + self.units) as usize
    }
}

/// The runs of one text node, in order, which are in order of source and of byte at once.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceMap {
    runs: Vec<Run>,
}

/// A piece that is the text of a `#text` node, and how its data maps onto the piece.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextSource {
    pub node: u64,
    pub map: SourceMap,
}

fn units_of(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte of `text` where `units` UTF-16 code units end, rounded up to the end of a character when
/// they end inside a surrogate pair.
fn bytes_for_units(text: &str, units: usize) -> usize {
    let mut seen = 0;
    for (byte, c) in text.char_indices() {
        if seen >= units {
            return byte;
        }
        seen += c.len_utf16();
    }
    text.len()
}

impl SourceMap {
    /// Notes that the character of `units` code units at `source` was kept as the `len` bytes at `byte`.
    pub fn keep(&mut self, source: usize, units: usize, byte: usize, len: usize) {
        if let Some(last) = self.runs.last_mut() {
            if last.source_end() == source && last.byte_end() == byte {
                last.units += units as u32;
                last.len += len as u32;
                return;
            }
        }
        self.runs.push(Run { source: source as u32, units: units as u32, byte: byte as u32, len: len as u32 });
    }

    /// The last kept character, a space or a line feed, was removed from the end of the text.
    pub fn drop_last_space(&mut self) {
        let Some(last) = self.runs.last_mut() else { return };
        last.units -= 1;
        last.len -= 1;
        if last.len == 0 {
            self.runs.pop();
        }
    }

    pub fn runs(&self) -> &[Run] {
        &self.runs
    }

    /// The byte of the paragraph text that is `offset` code units into the data. A position in
    /// characters that collapsed is where they would have been: after the character kept before them.
    /// `text` is the paragraph text and `piece` the bytes of this node in it.
    pub fn byte_at(&self, text: &str, piece: &Range<usize>, offset: usize) -> usize {
        let mut after = piece.start;
        for run in &self.runs {
            if offset < run.source as usize {
                return after;
            }
            if offset < run.source_end() {
                let within = &text[run.byte as usize..run.byte_end()];
                return run.byte as usize + bytes_for_units(within, offset - run.source as usize);
            }
            after = run.byte_end();
        }
        after.min(piece.end)
    }

    /// The offset in the data of `byte` of the paragraph text, which must be in the piece. A byte
    /// where kept characters meet after dropped ones is the offset after them, which is where a caret
    /// before the next character is.
    pub fn offset_at(&self, text: &str, piece: &Range<usize>, byte: usize) -> usize {
        let byte = byte.clamp(piece.start, piece.end);
        let mut end = 0;
        for run in &self.runs {
            if byte < run.byte as usize {
                return run.source as usize;
            }
            if byte < run.byte_end() {
                return run.source as usize + units_of(&text[run.byte as usize..byte]);
            }
            end = run.source_end();
        }
        end
    }
}

/// Which text node a byte on the border of two takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bias {
    /// The end of the node before.
    Before,
    /// The start of the node after, the end of the last one at the end of the paragraph.
    After,
}

/// A DOM position: the id of a `#text` node, and an offset in UTF-16 code units of its data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DomPoint {
    pub node: u64,
    pub offset: usize,
}

fn text_pieces(paragraph: &Paragraph) -> impl Iterator<Item = (&Piece, &TextSource)> {
    paragraph.pieces.iter().filter_map(|piece| piece.text.as_ref().map(|source| (piece, source)))
}

/// The bytes of the paragraph text that the position is at, or `None` when the node is not in the
/// paragraph or has no text left in it.
pub fn byte_of(paragraph: &Paragraph, node: u64, offset: usize) -> Option<usize> {
    let (piece, source) = text_pieces(paragraph).find(|(_, source)| source.node == node)?;
    Some(source.map.byte_at(&paragraph.text, &piece.range, offset))
}

/// The bytes of the paragraph that the child `node` of a container takes: a text's, an atomic inline's
/// or an inline box's (a line break is one). `None` when the paragraph does not hold it.
pub fn extent_of(paragraph: &Paragraph, node: u64) -> Option<Range<usize>> {
    if let Some((piece, _)) = text_pieces(paragraph).find(|(_, source)| source.node == node) {
        return Some(piece.range.clone());
    }
    if let Some((_, piece)) = paragraph.atomics().find(|(id, _)| *id == node) {
        return Some(piece.range.clone());
    }
    paragraph.boxes.iter().find(|(id, _)| *id == node).map(|(_, range)| range.clone())
}

/// The DOM position of `byte` of the paragraph text. A byte in something that is not text, a line
/// break or an atomic inline, is the end of the text before it, or the start of the one after it
/// when none is. `None` when the paragraph has no text node.
pub fn point_at(paragraph: &Paragraph, byte: usize, bias: Bias) -> Option<DomPoint> {
    let mut touching = text_pieces(paragraph).filter(|(piece, _)| piece.range.start <= byte && byte <= piece.range.end);
    let chosen = match bias {
        Bias::Before => touching.next(),
        Bias::After => touching.last(),
    };
    let (piece, source) = match chosen {
        Some(found) => found,
        None => text_pieces(paragraph)
            .filter(|(piece, _)| piece.range.end <= byte)
            .last()
            .or_else(|| text_pieces(paragraph).find(|(piece, _)| piece.range.start >= byte))?,
    };
    Some(DomPoint { node: source.node, offset: source.map.offset_at(&paragraph.text, &piece.range, byte) })
}

/// Every paragraph a plan holds, in order, whether it is a child of the container or of the anonymous
/// cell around table parts.
pub fn paragraphs_of(planned: &Planned) -> Vec<&Paragraph> {
    fn collect<'a>(child: &'a Child, out: &mut Vec<&'a Paragraph>) {
        match child {
            Child::Paragraph(paragraph) => out.push(paragraph),
            Child::AnonymousCell(cell) => cell.iter().for_each(|(child, _)| collect(child, out)),
            Child::Block(_) | Child::AnonymousTable(_) | Child::EmptyLine | Child::BlankLine => {}
        }
    }
    let mut out = Vec::new();
    planned.children.iter().for_each(|(child, _)| collect(child, &mut out));
    out
}

/// The plan of the block container that paints a text node, and the paragraph of the plan that
/// holds it.
pub struct Located {
    planned: Arc<Planned>,
    at: usize,
}

impl Located {
    pub fn paragraph(&self) -> &Paragraph {
        paragraphs_of(&self.planned)[self.at]
    }
}

fn holds(element: &RetainedElement, tree: &RetainedTree, node: u64) -> Option<Located> {
    let planned = plan_cache::planned(tree, element);
    let at = paragraphs_of(&planned).iter().position(|paragraph| text_pieces(paragraph).any(|(_, source)| source.node == node))?;
    Some(Located { planned, at })
}

/// The paragraph that paints the `#text` node `node`. It climbs from the node through the inline
/// elements around it to the block container that planned them, which is the first ancestor that is
/// not part of a paragraph itself.
pub fn locate(tree: &RetainedTree, node: u64) -> Option<Located> {
    if !crate::text::inline::is_raw_text(tree.elements.get(&node)?) {
        return None;
    }
    let mut parent = crate::layout::contents::splice_parent(tree, node)?;
    // An inline element plans its own children as a paragraph too, but it is the block around it
    // that paints them.
    // A box with `display: none` is climbed past too, to the container whose plan leaves it out.
    while crate::text::inline::is_part_of_paragraph(tree, parent) || crate::layout::box_generation::is_display_none(parent) {
        parent = crate::layout::contents::splice_parent(tree, parent.id)?;
    }
    holds(parent, tree, node)
}

/// The container a registry key `container:index` names.
pub fn container_of_key(key: &str) -> Option<u64> {
    key.split_once(':')?.0.parse().ok()
}

/// The paragraph the registry key `container:index` names (`Paragraph::key`), or `None` for a key of
/// text that is not a DOM paragraph.
pub fn locate_key(tree: &RetainedTree, key: &str) -> Option<Located> {
    let (container, index) = key.split_once(':')?;
    let element = tree.elements.get(&container.parse().ok()?)?;
    let index: usize = index.parse().ok()?;
    let planned = plan_cache::planned(tree, element);
    let at = paragraphs_of(&planned).iter().position(|paragraph| paragraph.index == index)?;
    Some(Located { planned, at })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::StyleDesc;

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

        fn white_space(&mut self, id: u64, value: &str) -> &mut Self {
            let style: StyleDesc = serde_json::from_value(serde_json::json!({ "whiteSpace": value })).expect("a style");
            self.tree.set_style_arc(id, std::sync::Arc::new(style));
            self
        }

        fn paragraph(&self, container: u64) -> Paragraph {
            let planned = plan_cache::planned(&self.tree, &self.tree.elements[&container]);
            paragraphs_of(&planned).first().map(|paragraph| (*paragraph).clone()).expect("a paragraph")
        }
    }

    /// Every offset of the data that has a byte and the offset that byte reads back as.
    fn round_trip(paragraph: &Paragraph, node: u64, data: &str) -> Vec<(usize, usize, usize)> {
        let units = data.encode_utf16().count();
        (0..=units)
            .filter_map(|offset| {
                let byte = byte_of(paragraph, node, offset)?;
                let back = point_at(paragraph, byte, Bias::After)?;
                (back.node == node).then_some((offset, byte, back.offset))
            })
            .collect()
    }

    #[test]
    fn a_registry_key_names_its_container() {
        assert_eq!(container_of_key("12:3"), Some(12));
        assert_eq!(container_of_key("12"), None);
        assert_eq!(container_of_key("a:3"), None);
    }

    #[test]
    fn text_that_collapses_nothing_is_one_run_and_counts_utf16_units() {
        let mut f = Fixture::new();
        f.text(1, 2, "h\u{e9}llo \u{1F600}x");
        let paragraph = f.paragraph(1);
        let piece = &paragraph.pieces[0];
        assert_eq!(piece.text.as_ref().expect("a text piece").map.runs().len(), 1);
        // "h", "é" (2 bytes), "llo ", the emoji (4 bytes, 2 units), "x".
        assert_eq!(byte_of(&paragraph, 2, 2), Some(3));
        assert_eq!(byte_of(&paragraph, 2, 6), Some(7));
        assert_eq!(byte_of(&paragraph, 2, 8), Some(11));
        assert_eq!(byte_of(&paragraph, 2, 9), Some(12));
        assert_eq!(point_at(&paragraph, 11, Bias::After), Some(DomPoint { node: 2, offset: 8 }));
        // Inside the surrogate pair the offset rounds up to the end of the emoji.
        assert_eq!(byte_of(&paragraph, 2, 7), Some(11));
    }

    #[test]
    fn collapsed_spaces_are_where_the_character_kept_before_them_ends() {
        let mut f = Fixture::new();
        f.text(1, 2, "a   b");
        let paragraph = f.paragraph(1);
        assert_eq!(paragraph.text, "a b");
        let map = &paragraph.pieces[0].text.as_ref().expect("a text piece").map;
        assert_eq!(map.runs().len(), 2, "`a ` and `b`: the dropped spaces are the gap");
        assert_eq!(byte_of(&paragraph, 2, 1), Some(1));
        for dropped in [2, 3] {
            assert_eq!(byte_of(&paragraph, 2, dropped), Some(2), "offset {dropped}");
        }
        assert_eq!(byte_of(&paragraph, 2, 4), Some(2));
        assert_eq!(byte_of(&paragraph, 2, 5), Some(3));
        // A byte where kept characters meet after dropped ones reads as the offset after them.
        assert_eq!(point_at(&paragraph, 2, Bias::After), Some(DomPoint { node: 2, offset: 4 }));
    }

    #[test]
    fn leading_and_trailing_space_of_a_paragraph_are_gone() {
        let mut f = Fixture::new();
        f.text(1, 2, "  a  ");
        let paragraph = f.paragraph(1);
        assert_eq!(paragraph.text, "a");
        assert_eq!(byte_of(&paragraph, 2, 0), Some(0));
        assert_eq!(byte_of(&paragraph, 2, 2), Some(0));
        assert_eq!(byte_of(&paragraph, 2, 3), Some(1));
        assert_eq!(byte_of(&paragraph, 2, 5), Some(1));
        assert_eq!(point_at(&paragraph, 1, Bias::After), Some(DomPoint { node: 2, offset: 3 }));
    }

    #[test]
    fn pre_wrap_keeps_every_space_and_drops_the_carriage_return_of_a_crlf() {
        let mut f = Fixture::new();
        f.white_space(1, "pre-wrap").text(1, 2, "a  b\nc\r\nd");
        let paragraph = f.paragraph(1);
        assert_eq!(paragraph.text, "a  b\nc\nd");
        let map = &paragraph.pieces[0].text.as_ref().expect("a text piece").map;
        assert_eq!(map.runs().len(), 2, "the \\r is the one gap");
        assert_eq!(byte_of(&paragraph, 2, 3), Some(3));
        assert_eq!(byte_of(&paragraph, 2, 6), Some(6));
        assert_eq!(byte_of(&paragraph, 2, 7), Some(6));
        assert_eq!(byte_of(&paragraph, 2, 9), Some(8));
        assert_eq!(point_at(&paragraph, 7, Bias::After), Some(DomPoint { node: 2, offset: 8 }));
    }

    #[test]
    fn a_lone_carriage_return_is_a_line_feed_of_the_same_length() {
        let mut f = Fixture::new();
        f.white_space(1, "pre-wrap").text(1, 2, "a\rb");
        let paragraph = f.paragraph(1);
        assert_eq!(paragraph.text, "a\nb");
        assert_eq!(round_trip(&paragraph, 2, "a\rb"), vec![(0, 0, 0), (1, 1, 1), (2, 2, 2), (3, 3, 3)]);
    }

    #[test]
    fn a_space_trimmed_before_a_line_feed_leaves_its_offset_at_the_trim() {
        let mut f = Fixture::new();
        f.white_space(1, "pre-line").text(1, 2, "a \nb");
        let paragraph = f.paragraph(1);
        assert_eq!(paragraph.text, "a\nb");
        assert_eq!(byte_of(&paragraph, 2, 1), Some(1));
        assert_eq!(byte_of(&paragraph, 2, 2), Some(1));
        assert_eq!(byte_of(&paragraph, 2, 3), Some(2));
        assert_eq!(byte_of(&paragraph, 2, 4), Some(3));
    }

    #[test]
    fn a_space_trimmed_from_an_earlier_node_is_taken_off_that_nodes_map() {
        let mut f = Fixture::new();
        f.white_space(1, "pre-line").text(1, 2, "a ").text(1, 3, "\nb");
        let paragraph = f.paragraph(1);
        assert_eq!(paragraph.text, "a\nb");
        let first = &paragraph.pieces[0];
        assert_eq!(first.range, 0..1);
        assert_eq!(first.text.as_ref().expect("a text piece").map.runs(), &[Run { source: 0, units: 1, byte: 0, len: 1 }]);
        assert_eq!(byte_of(&paragraph, 2, 2), Some(1));
        assert_eq!(byte_of(&paragraph, 3, 0), Some(1));
        assert_eq!(byte_of(&paragraph, 3, 2), Some(3));
    }

    #[test]
    fn a_node_whose_text_collapsed_away_has_no_position() {
        let mut f = Fixture::new();
        f.text(1, 2, "a");
        f.add(1, 3, "span").text(3, 4, " ");
        f.text(1, 5, "b");
        let paragraph = f.paragraph(1);
        assert_eq!(paragraph.text, "a b");
        // The span's space is the one kept between the letters; the node after it lost its own.
        assert_eq!(byte_of(&paragraph, 4, 1), Some(2));
        let mut f = Fixture::new();
        f.text(1, 2, "a ").text(1, 3, " ").text(1, 4, "b");
        let paragraph = f.paragraph(1);
        assert_eq!(paragraph.text, "a b");
        assert_eq!(byte_of(&paragraph, 3, 0), None);
    }

    #[test]
    fn a_paragraph_of_several_pieces_picks_the_node_by_the_bias_where_two_meet() {
        let mut f = Fixture::new();
        f.text(1, 2, "ab");
        f.add(1, 3, "span").text(3, 4, "cd");
        f.text(1, 5, "ef");
        let paragraph = f.paragraph(1);
        assert_eq!(paragraph.text, "abcdef");
        assert_eq!(byte_of(&paragraph, 4, 1), Some(3));
        assert_eq!(point_at(&paragraph, 2, Bias::Before), Some(DomPoint { node: 2, offset: 2 }));
        assert_eq!(point_at(&paragraph, 2, Bias::After), Some(DomPoint { node: 4, offset: 0 }));
        assert_eq!(point_at(&paragraph, 4, Bias::After), Some(DomPoint { node: 5, offset: 0 }));
        assert_eq!(point_at(&paragraph, 6, Bias::After), Some(DomPoint { node: 5, offset: 2 }));
        assert_eq!(point_at(&paragraph, 0, Bias::Before), Some(DomPoint { node: 2, offset: 0 }));
    }

    #[test]
    fn a_line_break_belongs_to_no_text_node() {
        let mut f = Fixture::new();
        f.text(1, 2, "ab").add(1, 3, "br");
        f.text(1, 4, "cd");
        let paragraph = f.paragraph(1);
        assert_eq!(paragraph.text, "ab\ncd");
        assert_eq!(paragraph.pieces[1].text, None);
        assert_eq!(point_at(&paragraph, 2, Bias::After), Some(DomPoint { node: 2, offset: 2 }));
        assert_eq!(point_at(&paragraph, 3, Bias::Before), Some(DomPoint { node: 4, offset: 0 }));
        assert_eq!(byte_of(&paragraph, 4, 1), Some(4));
    }

    #[test]
    fn a_node_is_found_through_the_inline_elements_around_it_and_not_through_a_block() {
        let mut f = Fixture::new();
        f.text(1, 2, "a");
        f.add(1, 3, "span");
        f.add(3, 4, "span").text(4, 5, "deep");
        f.add(1, 6, "div").text(6, 7, "block");
        let deep = locate(&f.tree, 5).expect("the paragraph of the container");
        assert_eq!(deep.paragraph().container, 1);
        assert_eq!(deep.paragraph().text, "adeep");
        let block = locate(&f.tree, 7).expect("the block is the container of its own text");
        assert_eq!(block.paragraph().container, 6);
        assert!(locate(&f.tree, 3).is_none(), "an element is not a text node");
        assert!(locate(&f.tree, 99).is_none());
    }

    #[test]
    fn a_key_names_the_paragraph_by_the_blocks_before_it() {
        let mut f = Fixture::new();
        f.text(1, 2, "one");
        f.add(1, 3, "div").text(3, 4, "two");
        f.text(1, 5, "three");
        let found = locate_key(&f.tree, "1:1").expect("the second block of the container is a paragraph");
        assert_eq!(found.paragraph().text, "three");
        assert_eq!(locate(&f.tree, 5).expect("located").paragraph().key().as_ref(), "1:1");
        assert!(locate_key(&f.tree, "1:7").is_none());
        assert_eq!(locate_key(&f.tree, "1:0").expect("the first").paragraph().text, "one");
        assert!(locate_key(&f.tree, "x").is_none());
    }

    #[test]
    fn a_node_that_has_no_display_is_not_in_a_paragraph() {
        let mut f = Fixture::new();
        f.text(1, 2, "a");
        f.add(1, 3, "span").text(3, 4, "hidden");
        let style: StyleDesc = serde_json::from_value(serde_json::json!({ "display": "none" })).expect("a style");
        f.tree.set_style_arc(3, std::sync::Arc::new(style));
        assert!(locate(&f.tree, 4).is_none());
        assert_eq!(locate(&f.tree, 2).expect("located").paragraph().text, "a");
    }

    #[test]
    fn source_map_bookkeeping() {
        let mut map = SourceMap::default();
        map.keep(0, 1, 0, 1);
        map.keep(1, 1, 1, 1);
        assert_eq!(map.runs().len(), 1);
        map.keep(5, 1, 2, 1);
        assert_eq!(map.runs().len(), 2);
        map.drop_last_space();
        assert_eq!(map.runs().len(), 1);
        map.drop_last_space();
        map.drop_last_space();
        assert!(map.runs().is_empty());
        map.drop_last_space();
    }
}
