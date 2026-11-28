//! Cross-element text selection state.
//!
//! Ported from Comet, MIT.
//! Upstream: https://github.com/zeronsh/comet/blob/main/crates/ui/src/markdown/selection.rs
//! Reviewed fix: https://github.com/zeronsh/comet/commit/3536a3702ca405fec1321e95f54e280240c5d38f
//!
//! GPUI has no built-in selection for plain text. Zed's markdown selects
//! continuously because its whole document is ONE element over one text model.
//! GPUIX renders a TREE of text elements, so this module rebuilds that
//! continuity: every frame the renderer registers each painted text element in
//! paint order, and a drag anchored in one element resolves against that
//! registry, SORTED INTO DOCUMENT ORDER by [`DocPos`], into per-element SPANS —
//! partial in the anchor and head elements, whole for every element between.
//! Paint order is not document order: a positioned element is lifted and paints
//! after the siblings that follow it. The wash paints per element from its span;
//! copy joins the spans in order. Hit testing alone stays in paint order.
//!
//! This is the pure state half. It has no gpui dependency so it can be unit
//! tested without a window. The registry, geometry and mouse listeners live in
//! [`super::paint`].
//!
//! Difference from Comet: the state lives in a `SelectionState` value owned by
//! `GpuixView` instead of a process-global. GPUIX is a library and a process may
//! host more than one renderer, so a global would let two windows fight over one
//! selection.

use std::ops::Range;
use std::sync::Arc;

/// One level of a document position: a run, and the byte of it where the next level sits.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Host {
    path: Arc<[u32]>,
    sub: usize,
    offset: usize,
}

/// Where a text sits in the document before its own `sub` is known: the child indices of its
/// element from the root through the retained tree, and the paragraphs that host it.
///
/// A text inside an atomic inline (`display: inline-block`) is hosted by the paragraph the box
/// sits in, at the byte of the box's placeholder. The text before the box and the text after it
/// are one run of that paragraph, so only the byte tells the box's text where it falls between
/// them.
#[derive(Clone, Debug, Default)]
pub struct DocPath {
    hosts: Arc<[Host]>,
    path: Arc<[u32]>,
}

impl DocPath {
    pub fn new(hosts: Arc<[Host]>, path: Arc<[u32]>) -> Self {
        Self { hosts, path }
    }

    /// The path of the box whose placeholder is at `offset` of the run `sub` of this element, for
    /// the texts built inside that box. What is built inside the box does not start its path over: it
    /// is the path the document has there, the child indices from the root, so it starts with the path
    /// of this element (and with the path of any root this element is in).
    pub fn host(&self, sub: usize, offset: usize) -> Arc<[Host]> {
        let level = Host {
            path: self.path.clone(),
            sub,
            offset,
        };
        self.hosts.iter().cloned().chain(std::iter::once(level)).collect()
    }
}

impl DocPath {
    /// Whether the position is not inside a paragraph that hosts it.
    pub fn is_plain(&self) -> bool {
        self.hosts.is_empty()
    }

    /// This path once the child of `parent` it is under (`parent` followed by the index `from`) has the index `to`: a sibling moved
    /// by what was taken out or put in before it. The paragraphs that host it move with it. `None` when it is not under that child.
    pub fn moved_sibling(&self, parent: &[u32], from: u32, to: u32) -> Option<DocPath> {
        let moved = |path: &Arc<[u32]>| -> Option<Arc<[u32]>> {
            match path.strip_prefix(parent) {
                Some([sibling, ..]) if *sibling == from => {
                    let mut moved = path.to_vec();
                    moved[parent.len()] = to;
                    Some(moved.into())
                }
                _ => None,
            }
        };
        let (path, hosts): (Option<Arc<[u32]>>, Vec<Option<Arc<[u32]>>>) = (moved(&self.path), self.hosts.iter().map(|host| moved(&host.path)).collect());
        if path.is_none() && hosts.iter().all(Option::is_none) {
            return None;
        }
        Some(DocPath {
            hosts: self.hosts.iter().zip(hosts).map(|(host, moved)| Host { path: moved.unwrap_or_else(|| host.path.clone()), ..host.clone() }).collect(),
            path: path.unwrap_or_else(|| self.path.clone()),
        })
    }

    /// The index of the element this is the path of among its siblings, and the path of the parent.
    pub fn parent_and_index(&self) -> Option<(&[u32], u32)> {
        self.path.split_last().map(|(index, parent)| (parent, *index))
    }

    /// This path as seen from `root`, the path of an element it is inside: what `root` has in
    /// common with it is left out, so the result stays the same when something is inserted before
    /// `root`. [`Self::under`] puts it back.
    pub fn relative_to(&self, root: &DocPath) -> DocPath {
        let (hosts, last) = strip_root(&self.hosts, &host_of(&self.path), root);
        DocPath { hosts, path: last.path }
    }

    /// `self`, as seen from `root` (see [`Self::relative_to`]), in the document `root` is in.
    pub fn under(&self, root: &DocPath) -> DocPath {
        let (hosts, last) = put_under_root(&self.hosts, &host_of(&self.path), root);
        DocPath { hosts, path: last.path }
    }
}

fn host_of(path: &Arc<[u32]>) -> Host {
    Host { path: path.clone(), sub: 0, offset: 0 }
}

/// The levels `hosts` and `last` hold with `root`'s taken off the front: the paragraphs `root` is inside are left out, and the path
/// of `root` is taken off the path of every level after them, the paragraphs that host a box of the root as well as the text
/// (a box's content does not start its path over, see [`DocPath::host`]).
///
/// A position that is not under `root` is a bug in the document path, which a debug build asserts and a release build keeps as it
/// is. Every caller strips a position from the root it was recorded under, or a root from the root it was nested in, and takes
/// the root from the same tape: the path a replay has for a root is [`crate::tape::TapeStore::doc_of`], which is where the
/// root that holds the recording has it now.
fn strip_root(hosts: &Arc<[Host]>, last: &Host, root: &DocPath) -> (Arc<[Host]>, Host) {
    let shared = root.hosts.len();
    let under = hosts.len() >= shared && hosts[..shared] == root.hosts[..];
    debug_assert!(under, "a document position is under the paragraphs that host its root: {hosts:?} under {root:?}");
    if !under {
        return (hosts.clone(), last.clone());
    }
    let strip = |host: &Host| match host.path.strip_prefix(&root.path[..]) {
        Some(path) => Host { path: path.into(), ..host.clone() },
        None => {
            debug_assert!(false, "a document position is under the path of its root: {:?} under {:?}", host.path, root.path);
            host.clone()
        }
    };
    (hosts[shared..].iter().map(strip).collect(), strip(last))
}

/// The inverse of [`strip_root`].
fn put_under_root(hosts: &Arc<[Host]>, last: &Host, root: &DocPath) -> (Arc<[Host]>, Host) {
    let put = |host: &Host| Host { path: root.path.iter().chain(host.path.iter()).copied().collect(), ..host.clone() };
    (root.hosts.iter().cloned().chain(hosts.iter().map(put)).collect(), put(last))
}

impl From<Arc<[u32]>> for DocPath {
    fn from(path: Arc<[u32]>) -> Self {
        Self::new(Arc::from([]), path)
    }
}

/// Where a text run sits in the document, for ordering selection and find.
///
/// The path of child indices from the root through the retained tree, then the run's `sub`.
/// Tree order, not flex or grid `order` and not paint order, as in a browser, where the
/// selection and Ctrl+F follow the DOM. A shorter path that is a prefix of a longer one comes
/// first, so a container's own text precedes its children's. A text inside an atomic inline
/// sorts at the byte of the box's placeholder in the paragraph around it: see [`DocPath`].
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct DocPos {
    hosts: Arc<[Host]>,
    own: Host,
}

impl DocPos {
    pub fn new(path: impl Into<DocPath>, sub: usize) -> Self {
        let path = path.into();
        Self {
            hosts: path.hosts,
            own: Host {
                path: path.path,
                sub,
                offset: 0,
            },
        }
    }

    /// The position of `offset` bytes into this run.
    pub fn at(&self, offset: usize) -> Self {
        Self {
            hosts: self.hosts.clone(),
            own: Host {
                offset,
                ..self.own.clone()
            },
        }
    }

    /// This position as seen from `root`, the path of an element the text is inside (see
    /// [`DocPath::relative_to`]). What a retained subtree keeps of where its text is, so that
    /// the subtree is not built again because its place among its siblings moved.
    pub fn relative_to(&self, root: &DocPath) -> Self {
        let (hosts, own) = strip_root(&self.hosts, &self.own, root);
        Self { hosts, own }
    }

    /// The position that `self`, seen from `root`, has in the document `root` is in.
    pub fn under(&self, root: &DocPath) -> Self {
        let (hosts, own) = put_under_root(&self.hosts, &self.own, root);
        Self { hosts, own }
    }

    /// How many atomic inlines the run sits inside.
    pub fn depth(&self) -> usize {
        self.hosts.len()
    }

    fn levels(&self) -> impl Iterator<Item = &Host> {
        self.hosts.iter().chain(std::iter::once(&self.own))
    }
}

impl Ord for DocPos {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.levels().cmp(other.levels())
    }
}

impl PartialOrd for DocPos {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// The indices of `positions` in document order. Equal positions keep their paint order, so a
/// row gpui paints twice stays adjacent to itself.
pub fn document_order(positions: &[&DocPos]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..positions.len()).collect();
    order.sort_by(|a, b| positions[*a].cmp(positions[*b]));
    order
}

/// The table cell a run of text is in, see [`RegisteredText::cell`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TableCell {
    /// What names the row of the cell, or what stands for it when the cells have none.
    pub row: u64,
    pub cell: u64,
}

/// One element's slice of the selection, in document order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    /// Element key — the numeric element id rendered as a string, plus a
    /// sub-index for elements that paint more than one text run.
    pub key: String,
    /// Selected byte range of the element's flat text.
    pub range: Range<usize>,
    /// The element's full flat text. Snapshotted at drag time so copy still
    /// works after the element scrolls out of the registry.
    pub text: String,
    /// See [`RegisteredText::group`].
    pub group: Option<u64>,
    /// See [`RegisteredText::line`].
    pub line: Option<String>,
    /// See [`RegisteredText::cell`].
    pub cell: Option<TableCell>,
}

impl Span {
    fn fits(&self, element: &RegisteredText) -> bool {
        self.key == element.key
            && element.window.0 <= self.range.start
            && self.range.end <= element.window.1
    }
}

/// One painted text element as the frame registry sees it.
#[derive(Clone, Copy, Debug)]
pub struct RegisteredText<'a> {
    pub key: &'a str,
    pub text: &'a str,
    /// The bytes of `text` this entry stands for. A paragraph with atomic inlines is one painted
    /// string, but the text of a box in it falls between the text before and the text after the
    /// box, so it is several entries, one per stretch between placeholders.
    pub window: (usize, usize),
    /// The line this run is on, for runs that share one without being in one string: the text
    /// of an atomic inline is on the line of the paragraph the box sits in, so `a <box>b</box> c`
    /// copies as `a b c`, but the text of a block in the box is on a line of its own. Copy puts a
    /// line break between two runs unless they share a group or a line.
    pub line: Option<&'a str>,
    /// Id of the host element whose primitive text children this run belongs
    /// to, or `None` for a run that never merges with a neighbour.
    ///
    /// React makes a separate host node for every interpolated string
    /// (`shouldSetTextContent` is false), so `<div>Hello {name}!</div>` is
    /// three painted runs of one logical line. They share a group, and copy
    /// must join them with nothing. Anything else is a separate line and joins
    /// with a newline.
    pub group: Option<u64>,
    /// The cell of a table the run is in. Copy puts a tab, where it puts a line break, between runs
    /// of different cells of one row, as Chrome does.
    pub cell: Option<TableCell>,
    /// Bytes of `text` that are painted and are not text of the document: the content of a
    /// `::before` or `::after`. A selection runs over them and copy leaves them out, as it does the
    /// placeholder of an atomic inline.
    pub holes: &'a [Range<usize>],
}

impl<'a> RegisteredText<'a> {
    /// A run that has no atomic inline in it.
    pub fn whole(key: &'a str, text: &'a str, group: Option<u64>) -> Self {
        Self {
            key,
            text,
            window: (0, text.len()),
            line: None,
            group,
            cell: None,
            holes: &[],
        }
    }

    fn holds(&self, ix: usize) -> bool {
        self.window.0 <= ix && ix <= self.window.1
    }
}

/// Where in `elements` a byte `ix` of the run `key` is: the entry that holds it, or the last one
/// before it when it is the placeholder of a box.
fn locate(elements: &[RegisteredText], key: &str, ix: usize) -> Option<usize> {
    let mut before = None;
    for (at, element) in elements.iter().enumerate().filter(|(_, element)| element.key == key) {
        if element.holds(ix) {
            return Some(at);
        }
        if element.window.1 < ix {
            before = Some(at);
        }
    }
    before.or_else(|| elements.iter().position(|element| element.key == key))
}

/// `painted` with each run that has atomic inlines in it cut at their placeholders, as
/// `(index into painted, entry, position)`.
fn segments<'a>(
    painted: &[(RegisteredText<'a>, &DocPos)],
) -> Vec<(usize, RegisteredText<'a>, DocPos)> {
    let mut out = Vec::with_capacity(painted.len());
    for (ix, (run, doc)) in painted.iter().enumerate() {
        let mut start = run.window.0;
        let mut whole: Vec<(usize, usize)> = Vec::new();
        for (at, placeholder) in run.text.match_indices(gpui::OBJECT_REPLACEMENT_CHARACTER) {
            if at >= run.window.0 && at < run.window.1 {
                whole.push((start, at));
                start = at + placeholder.len();
            }
        }
        whole.push((start, run.window.1));
        let first = out.len();
        for (from, to) in whole {
            let mut start = from;
            let mut holes: Vec<&Range<usize>> = run.holes.iter().filter(|hole| hole.start < to && hole.end > from).collect();
            holes.sort_by_key(|hole| hole.start);
            for hole in &holes {
                if hole.start > start {
                    out.push((ix, RegisteredText { window: (start, hole.start), ..*run }, doc.at(start)));
                }
                start = start.max(hole.end);
            }
            if holes.is_empty() || start < to {
                out.push((ix, RegisteredText { window: (start, to), ..*run }, doc.at(start)));
            }
        }
        // A run that is all hole is still a place the pointer can be on, and holds nothing to select.
        if out.len() == first {
            out.push((ix, RegisteredText { window: (run.window.1, run.window.1), ..*run }, doc.at(run.window.1)));
        }
    }
    out
}

/// Live selection for one renderer.
#[derive(Clone, Debug, Default)]
pub struct SelectionState {
    /// Element that owns the drag (where the mouse went down).
    anchor_key: String,
    /// Byte offset of the anchor within its element.
    anchor_ix: usize,
    dragging: bool,
    /// Direction established while the anchor is still painted.
    forward: Option<bool>,
    /// Resolved spans in document order. Empty while a click has not moved.
    spans: Vec<Span>,
    active: bool,
    /// Mouse-down hit that has not become a drag yet. A tap must not select
    /// or blur; iOS treats that tap as scroll or focus. Promoted on the first
    /// dragging move, or replaced by `begin_with_span` for double-click.
    pending: bool,
}

impl SelectionState {
    /// Remember a press without selecting. The next dragging move promotes it.
    pub fn arm(&mut self, key: &str, ix: usize) {
        self.anchor_key = key.to_string();
        self.anchor_ix = ix;
        self.dragging = false;
        self.forward = None;
        self.active = false;
        self.pending = true;
        self.spans.clear();
    }

    /// Turn a pending press into a live drag. True when this call started it.
    pub fn promote_pending(&mut self) -> bool {
        if !self.pending {
            return false;
        }
        self.pending = false;
        self.dragging = true;
        self.active = true;
        true
    }

    pub fn cancel_pending(&mut self) {
        if self.pending {
            *self = SelectionState::default();
        }
    }

    pub fn is_pending(&self) -> bool {
        self.pending
    }

    /// Begin with an immediate span — double or triple click inside one element.
    pub fn begin_with_span(&mut self, key: &str, text: &str, range: Range<usize>) {
        self.anchor_key = key.to_string();
        self.anchor_ix = range.start;
        self.dragging = true;
        self.forward = None;
        self.active = true;
        self.pending = false;
        self.spans = vec![Span {
            key: key.to_string(),
            range,
            text: text.to_string(),
            group: None,
            line: None,
            cell: None,
        }];
    }

    pub fn is_dragging(&self) -> bool {
        self.active && self.dragging
    }

    /// [`Self::update_drag`] for runs in PAINT order: `head` indexes `painted`, as the hit test
    /// that found it did, and the spans come out in document order.
    pub fn update_drag_painted(
        &mut self,
        painted: &[(RegisteredText, &DocPos)],
        head: (usize, usize),
    ) -> bool {
        let segments = segments(painted);
        let positions: Vec<&DocPos> = segments.iter().map(|(_, _, doc)| doc).collect();
        let order = document_order(&positions);
        let holding = |segment: &&(usize, RegisteredText, DocPos)| segment.0 == head.0;
        let head_segment = segments
            .iter()
            .position(|segment| holding(&segment) && segment.1.holds(head.1))
            .or_else(|| {
                segments
                    .iter()
                    .rposition(|segment| holding(&segment) && segment.1.window.1 < head.1)
            })
            .or_else(|| segments.iter().position(|segment| holding(&segment)));
        let Some(head_in_document) =
            head_segment.and_then(|head| order.iter().position(|ix| *ix == head))
        else {
            return false;
        };
        let elements: Vec<RegisteredText> = order.iter().map(|ix| segments[*ix].1).collect();
        self.update_drag(&elements, (head_in_document, head.1))
    }

    /// Resolve a drag head against this frame's visible runs, in document order.
    ///
    /// Once virtualization removes the anchor, an overlapping selected run
    /// joins the visible frame to the spans retained from earlier frames.
    pub fn update_drag(&mut self, elements: &[RegisteredText], head: (usize, usize)) -> bool {
        if !self.is_dragging() {
            return false;
        }
        let spans = if let Some(anchor_element) = locate(elements, &self.anchor_key, self.anchor_ix)
        {
            let anchor = (anchor_element, self.anchor_ix);
            self.forward = Some(anchor <= head);
            resolve_spans(elements, anchor, head)
        } else {
            let Some(forward) = self.forward else {
                return false;
            };
            let Some(spans) = extend_virtualized_drag(&self.spans, elements, head, forward) else {
                return false;
            };
            spans
        };
        self.update_spans(spans)
    }

    /// Replace the resolved spans. Returns true when they changed.
    pub fn update_spans(&mut self, spans: Vec<Span>) -> bool {
        if !self.active || self.spans == spans {
            return false;
        }
        self.spans = spans;
        true
    }

    /// End the active drag even when its anchor is no longer painted.
    pub fn end_active_drag(&mut self) -> Option<String> {
        if !self.is_dragging() {
            return None;
        }
        self.dragging = false;
        if self.spans.iter().all(|span| span.range.is_empty()) {
            self.clear();
            return None;
        }
        Some(join_spans(&self.spans))
    }

    pub fn clear(&mut self) {
        *self = SelectionState::default();
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// The wash ranges for `key` this frame, in order. Empty means nothing to paint. A paragraph
    /// with a box in it has one on each side of the box.
    pub fn wash_ranges(&self, key: &str) -> Vec<Range<usize>> {
        if !self.active {
            return Vec::new();
        }
        self.spans
            .iter()
            .filter(|s| s.key == key && !s.range.is_empty())
            .map(|s| s.range.clone())
            .collect()
    }

    #[cfg(test)]
    fn wash_range(&self, key: &str) -> Option<Range<usize>> {
        self.wash_ranges(key).into_iter().next()
    }

    /// The full selected text, spans joined in document order.
    pub fn selected_text(&self) -> Option<String> {
        if !self.active || self.spans.iter().all(|s| s.range.is_empty()) {
            return None;
        }
        Some(join_spans(&self.spans))
    }

    /// Identity of the current selected range set. Empty selection is `0`.
    ///
    /// `onSelectionChange` keys on this so an unchanged frame does not emit.
    pub fn identity(&self) -> u64 {
        if !self.active {
            return 0;
        }
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        let mut any = false;
        for span in self.spans.iter().filter(|span| !span.range.is_empty()) {
            span.key.hash(&mut hasher);
            span.range.start.hash(&mut hasher);
            span.range.end.hash(&mut hasher);
            span.group.hash(&mut hasher);
            span.text.hash(&mut hasher);
            any = true;
        }
        if !any {
            0
        } else {
            hasher.finish()
        }
    }
}

fn extend_virtualized_drag(
    existing: &[Span],
    elements: &[RegisteredText],
    head: (usize, usize),
    forward: bool,
) -> Option<Vec<Span>> {
    if forward {
        let (element_index, span_index) =
            elements
                .iter()
                .enumerate()
                .find_map(|(element_index, element)| {
                    existing
                        .iter()
                        .position(|span| span.fits(element))
                        .map(|span_index| (element_index, span_index))
                })?;
        let start = existing.get(span_index)?.range.start;
        let mut merged = existing.get(..span_index)?.to_vec();
        merged.extend(resolve_spans(elements, (element_index, start), head));
        Some(merged)
    } else {
        let (element_index, span_index) =
            elements
                .iter()
                .enumerate()
                .rev()
                .find_map(|(element_index, element)| {
                    existing
                        .iter()
                        .position(|span| span.fits(element))
                        .map(|span_index| (element_index, span_index))
                })?;
        let end = existing.get(span_index)?.range.end;
        let mut merged = resolve_spans(elements, head, (element_index, end));
        merged.extend_from_slice(existing.get(span_index + 1..)?);
        Some(merged)
    }
}

/// Resolve the spans for a selection between `a` and `b`, each an
/// `(element index, byte offset)` into `elements` (document-ordered painted
/// runs). Handles either direction; empty slices are skipped.
pub fn resolve_spans(
    elements: &[RegisteredText],
    a: (usize, usize),
    b: (usize, usize),
) -> Vec<Span> {
    let (start, end) = if (a.0, a.1) <= (b.0, b.1) {
        (a, b)
    } else {
        (b, a)
    };
    let mut spans = Vec::new();
    for (ei, entry) in elements.iter().enumerate().take(end.0 + 1).skip(start.0) {
        let text = entry.text;
        let from = if ei == start.0 { start.1 } else { entry.window.0 };
        let to = if ei == end.0 { end.1 } else { entry.window.1 };
        let within = |ix: usize| clamp_boundary(text, ix.clamp(entry.window.0, entry.window.1));
        let (from, to) = (within(from), within(to));
        if from < to {
            spans.push(Span {
                key: entry.key.to_string(),
                range: from..to,
                text: text.to_string(),
                group: entry.group,
                line: entry.line.map(str::to_owned),
                cell: entry.cell,
            });
        }
    }
    spans
}

/// Clamp a byte offset into `text` and snap it down to a char boundary.
/// Mouse-derived indices are already on boundaries; this is defensive so a
/// stale index from a previous frame's text can never panic on slicing.
fn clamp_boundary(text: &str, mut ix: usize) -> usize {
    ix = ix.min(text.len());
    while ix > 0 && !text.is_char_boundary(ix) {
        ix -= 1;
    }
    ix
}

/// Join spans in document order, with a newline between logical lines and
/// nothing between runs of the same group.
///
/// Without the group check, copying `<div>Hello {name}!</div>` yields
/// `"Hello\nTommy\n!"`, because React split one line into three host nodes.
fn join_spans(spans: &[Span]) -> String {
    let mut out = String::new();
    let mut previous: Option<&Span> = None;
    for span in spans.iter().filter(|s| !s.range.is_empty()) {
        if let Some(previous) = previous {
            if next_cell(previous, span) {
                out.push('\t');
            } else if !runs_into(previous, span) {
                out.push('\n');
            }
        }
        // The placeholder of an atomic inline is not text, and what is inside the box is a text of
        // its own; nor is the break opportunity of a `<wbr>`.
        out.extend(
            span.text[span.range.clone()]
                .chars()
                .filter(|c| *c != gpui::OBJECT_REPLACEMENT_CHARACTER && *c != crate::html::BREAK_OPPORTUNITY),
        );
        previous = Some(span);
    }
    out
}

/// Whether `next` is in another cell of the table row `previous` is in, where copy puts a tab, as
/// Chrome does.
fn next_cell(previous: &Span, next: &Span) -> bool {
    matches!((previous.cell, next.cell), (Some(a), Some(b)) if a.row == b.row && a.cell != b.cell)
}

/// Whether `next` continues the line `previous` is on.
fn runs_into(previous: &Span, next: &Span) -> bool {
    let same_group = next.group.is_some() && next.group == previous.group;
    let same_line = next.line.is_some() && next.line == previous.line;
    same_group || same_line
}

/// Word range around `ix` for double-click selection: an alphanumeric/`_` run,
/// or the single non-space char under the cursor, or empty at spaces.
pub fn word_range(text: &str, ix: usize) -> Range<usize> {
    let ix = clamp_boundary(text, ix);
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let before = text[..ix].chars().next_back();
    let at = text[ix..].chars().next();
    if !at.is_some_and(is_word) && !before.is_some_and(is_word) {
        return match at {
            Some(c) if !c.is_whitespace() => ix..ix + c.len_utf8(),
            _ => ix..ix,
        };
    }
    let start = text[..ix]
        .char_indices()
        .rev()
        .take_while(|(_, c)| is_word(*c))
        .last()
        .map(|(i, _)| i)
        .unwrap_or(ix);
    let end = text[ix..]
        .char_indices()
        .take_while(|(_, c)| is_word(*c))
        .last()
        .map(|(i, c)| ix + i + c.len_utf8())
        .unwrap_or(ix);
    start..end
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg<'a>(key: &'a str, text: &'a str, group: Option<u64>) -> RegisteredText<'a> {
        RegisteredText::whole(key, text, group)
    }

    fn on_line<'a>(key: &'a str, text: &'a str, line: &'a str) -> RegisteredText<'a> {
        RegisteredText { line: Some(line), ..RegisteredText::whole(key, text, None) }
    }

    #[test]
    fn copied_text_leaves_out_the_break_opportunity_of_a_wbr() {
        let text = "foo\u{200B}bar \u{FFFC} baz";
        let span = Span {
            key: "p".to_string(),
            range: 0..text.len(),
            text: text.to_string(),
            group: None,
            line: None,
            cell: None,
        };
        assert_eq!(join_spans(&[span]), "foobar  baz");
    }

    fn elems<'a>() -> Vec<RegisteredText<'a>> {
        vec![
            reg("p1", "first paragraph", None),
            reg("p2", "second", None),
            reg("p3", "third one", None),
        ]
    }

    /// `<div>Hello {name}!</div>`: one line, three host nodes, one group.
    fn interpolated<'a>() -> Vec<RegisteredText<'a>> {
        vec![
            reg("2:0", "Hello ", Some(1)),
            reg("3:0", "Tommy", Some(1)),
            reg("4:0", "!", Some(1)),
        ]
    }

    #[test]
    fn spans_within_one_element() {
        let spans = resolve_spans(&elems(), (0, 6), (0, 15));
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].key, "p1");
        assert_eq!(&spans[0].text[spans[0].range.clone()], "paragraph");
        assert_eq!(resolve_spans(&elems(), (0, 15), (0, 6)), spans);
    }

    #[test]
    fn spans_across_elements_cover_middles_whole() {
        let spans = resolve_spans(&elems(), (0, 6), (2, 5));
        assert_eq!(spans.len(), 3);
        assert_eq!(&spans[0].text[spans[0].range.clone()], "paragraph");
        assert_eq!(&spans[1].text[spans[1].range.clone()], "second");
        assert_eq!(&spans[2].text[spans[2].range.clone()], "third");
        assert_eq!(resolve_spans(&elems(), (2, 5), (0, 6)), spans);
    }

    #[test]
    fn drag_lifecycle_and_copy_joins() {
        let mut sel = SelectionState::default();
        sel.arm("p1", 6);
        assert!(sel.promote_pending());
        assert!(sel.is_dragging());
        let spans = resolve_spans(&elems(), (0, 6), (1, 6));
        assert!(sel.update_spans(spans.clone()));
        assert!(!sel.update_spans(spans));
        assert_eq!(sel.wash_range("p1"), Some(6..15));
        assert_eq!(sel.wash_range("p2"), Some(0..6));
        assert_eq!(sel.wash_range("p3"), None);
        assert_eq!(sel.end_active_drag().as_deref(), Some("paragraph\nsecond"));
        assert_eq!(sel.selected_text().as_deref(), Some("paragraph\nsecond"));
        let identity = sel.identity();
        assert_ne!(identity, 0);
        assert_eq!(sel.identity(), identity);
        sel.clear();
        assert_eq!(sel.selected_text(), None);
        assert_eq!(sel.identity(), 0);
    }

    #[test]
    fn drag_survives_forward_virtualization() {
        let mut sel = SelectionState::default();
        sel.arm("p1", 6);
        assert!(sel.promote_pending());
        assert!(sel.update_drag(&elems(), (2, 5)));
        let shifted = [
            reg("p2", "second", None),
            reg("p3", "third one", None),
            reg("p4", "fourth", None),
        ];
        assert!(sel.update_drag(&shifted, (2, 4)));
        assert_eq!(
            sel.selected_text().as_deref(),
            Some("paragraph\nsecond\nthird one\nfour")
        );
        assert_eq!(
            sel.end_active_drag().as_deref(),
            Some("paragraph\nsecond\nthird one\nfour")
        );
        assert!(!sel.is_dragging());
    }

    #[test]
    fn drag_survives_backward_virtualization() {
        let mut sel = SelectionState::default();
        sel.arm("p5", 4);
        assert!(sel.promote_pending());
        let first = [
            reg("p3", "third", None),
            reg("p4", "fourth", None),
            reg("p5", "fifth", None),
        ];
        assert!(sel.update_drag(&first, (0, 2)));
        let shifted = [
            reg("p2", "second", None),
            reg("p3", "third", None),
            reg("p4", "fourth", None),
        ];
        assert!(sel.update_drag(&shifted, (0, 3)));
        assert_eq!(
            sel.selected_text().as_deref(),
            Some("ond\nthird\nfourth\nfift")
        );
        assert_eq!(
            sel.end_active_drag().as_deref(),
            Some("ond\nthird\nfourth\nfift")
        );
    }

    #[test]
    fn virtualized_drag_requires_overlap() {
        let mut sel = SelectionState::default();
        sel.arm("p1", 6);
        assert!(sel.promote_pending());
        assert!(sel.update_drag(&elems(), (2, 5)));
        let unrelated = [reg("p8", "eighth", None), reg("p9", "ninth", None)];
        assert!(!sel.update_drag(&unrelated, (1, 3)));
        assert_eq!(
            sel.selected_text().as_deref(),
            Some("paragraph\nsecond\nthird")
        );
    }

    #[test]
    fn virtualized_drag_waits_until_direction_is_known() {
        let mut sel = SelectionState::default();
        sel.arm("p1", 6);
        assert!(sel.promote_pending());
        let shifted = [reg("p2", "second", None), reg("p3", "third", None)];
        assert!(!sel.update_drag(&shifted, (1, 3)));
        assert_eq!(sel.selected_text(), None);
    }

    #[test]
    fn virtualized_copy_preserves_grouped_and_ungrouped_runs() {
        let mut sel = SelectionState::default();
        sel.arm("2:0", 0);
        assert!(sel.promote_pending());
        let first = [
            reg("2:0", "Hello ", Some(1)),
            reg("3:0", "Tommy", Some(1)),
            reg("7:0", "let a = 1;", None),
        ];
        assert!(sel.update_drag(&first, (2, 10)));
        let shifted = [
            reg("3:0", "Tommy", Some(1)),
            reg("7:0", "let a = 1;", None),
            reg("7:1", "let b = 2;", None),
        ];
        assert!(sel.update_drag(&shifted, (2, 10)));
        assert_eq!(
            sel.selected_text().as_deref(),
            Some("Hello Tommy\nlet a = 1;\nlet b = 2;")
        );
    }

    #[test]
    fn empty_click_clears_on_release() {
        let mut sel = SelectionState::default();
        sel.arm("p1", 3);
        assert!(sel.promote_pending());
        assert_eq!(sel.end_active_drag(), None);
        assert_eq!(sel.selected_text(), None);
    }

    #[test]
    fn tap_does_not_select_until_drag() {
        let mut sel = SelectionState::default();
        sel.arm("p1", 3);
        assert!(sel.is_pending());
        assert!(!sel.is_active());
        assert!(!sel.is_dragging());
        sel.cancel_pending();
        assert!(!sel.is_pending());
        assert_eq!(sel.selected_text(), None);
    }

    #[test]
    fn pending_press_promotes_on_drag() {
        let mut sel = SelectionState::default();
        sel.arm("p1", 6);
        assert!(sel.promote_pending());
        assert!(!sel.promote_pending());
        assert!(sel.is_dragging());
        let spans = resolve_spans(&elems(), (0, 6), (0, 15));
        assert!(sel.update_spans(spans));
        assert_eq!(sel.end_active_drag().as_deref(), Some("paragraph"));
    }

    #[test]
    fn double_click_span() {
        let mut sel = SelectionState::default();
        sel.begin_with_span("p1", "hello world", 6..11);
        assert_eq!(sel.wash_range("p1"), Some(6..11));
        assert_eq!(sel.end_active_drag().as_deref(), Some("world"));
    }

    #[test]
    fn word_ranges() {
        let t = "let foo_bar = 12;";
        assert_eq!(word_range(t, 5), 4..11);
        assert_eq!(word_range(t, 4), 4..11);
        assert_eq!(word_range(t, 11), 4..11);
        assert_eq!(word_range(t, 15), 14..16);
        assert_eq!(&t[word_range(t, 12)], "=");
        assert_eq!(word_range(t, 3), 0..3);
        let u = "héllo wörld";
        assert_eq!(&u[word_range(u, 2)], "héllo");
    }

    /// A stale index past a shrunk element's text must clamp, not panic.
    #[test]
    fn resolve_spans_clamps_out_of_range_offsets() {
        let spans = resolve_spans(&[reg("a", "hé", None)], (0, 0), (0, 99));
        assert_eq!(&spans[0].text[spans[0].range.clone()], "hé");
    }

    /// React splits one line into three host nodes. Copy must not insert
    /// newlines between them.
    #[test]
    fn copy_joins_one_group_without_newlines() {
        let mut sel = SelectionState::default();
        sel.arm("2:0", 0);
        assert!(sel.promote_pending());
        let spans = resolve_spans(&interpolated(), (0, 0), (2, 1));
        assert!(sel.update_spans(spans));
        assert_eq!(sel.selected_text().as_deref(), Some("Hello Tommy!"));
    }

    #[test]
    fn copy_separates_groups_with_newlines() {
        let elements = vec![
            reg("2:0", "Hello ", Some(1)),
            reg("3:0", "Tommy", Some(1)),
            reg("5:0", "second line", Some(4)),
        ];
        let mut sel = SelectionState::default();
        sel.arm("2:0", 0);
        assert!(sel.promote_pending());
        assert!(sel.update_spans(resolve_spans(&elements, (0, 0), (2, 11))));
        assert_eq!(
            sel.selected_text().as_deref(),
            Some("Hello Tommy\nsecond line")
        );
    }

    /// Chrome copies a table as `a\tb\nc\td`: a tab between the cells of a row, a line break between
    /// rows, and between two lines of one cell.
    #[test]
    fn copy_puts_a_tab_between_the_cells_of_a_row() {
        let cell = |row, cell| Some(TableCell { row, cell });
        let run = |key, text, cell| RegisteredText { cell, ..RegisteredText::whole(key, text, None) };
        let elements = vec![
            run("a", "a", cell(1, 10)),
            run("b", "b", cell(1, 11)),
            run("b2", "b2", cell(1, 11)),
            run("c", "c", cell(2, 20)),
            run("d", "d", cell(2, 21)),
            run("e", "outside", None),
        ];
        let mut sel = SelectionState::default();
        sel.arm("a", 0);
        assert!(sel.promote_pending());
        assert!(sel.update_spans(resolve_spans(&elements, (0, 0), (5, 7))));
        assert_eq!(sel.selected_text().as_deref(), Some("a\tb\nb2\nc\td\noutside"));
    }

    /// `<code-block>` and `<diff>` register their runs without a group, so every
    /// line stays a line even though one element painted them all.
    #[test]
    fn ungrouped_runs_always_separate() {
        let elements = vec![
            reg("7:0", "let a = 1;", None),
            reg("7:1", "let b = 2;", None),
        ];
        let mut sel = SelectionState::default();
        sel.arm("7:0", 0);
        assert!(sel.promote_pending());
        assert!(sel.update_spans(resolve_spans(&elements, (0, 0), (1, 10))));
        assert_eq!(
            sel.selected_text().as_deref(),
            Some("let a = 1;\nlet b = 2;")
        );
    }

    fn at(path: &[u32], sub: usize) -> DocPos {
        DocPos::new(Arc::from(path), sub)
    }

    /// `[first, second, third]` in the document, where `first` is positioned: it paints last.
    fn lifted_first() -> (Vec<RegisteredText<'static>>, Vec<DocPos>) {
        (
            vec![
                reg("second", "second line", None),
                reg("third", "third line", None),
                reg("first", "first line", None),
            ],
            vec![at(&[1], 0), at(&[2], 0), at(&[0], 0)],
        )
    }

    fn painted<'a>(
        elements: &[RegisteredText<'a>],
        positions: &'a [DocPos],
    ) -> Vec<(RegisteredText<'a>, &'a DocPos)> {
        elements.iter().copied().zip(positions).collect()
    }

    #[test]
    fn document_order_sorts_by_path_then_sub() {
        let positions = [at(&[1, 0], 0), at(&[1], 3), at(&[0, 5], 0), at(&[1], 1), at(&[1, 0], 0)];
        let refs: Vec<&DocPos> = positions.iter().collect();
        // A container's own runs come before its children, and equal positions keep paint order.
        assert_eq!(document_order(&refs), vec![2, 3, 1, 0, 4]);
    }

    #[test]
    fn a_drag_over_a_lifted_run_selects_in_document_order() {
        let (elements, positions) = lifted_first();
        let runs = painted(&elements, &positions);
        let mut selection = SelectionState::default();
        // Pressed in "first" (paint index 2), dragged to the end of "third" (paint index 1).
        selection.arm("first", 0);
        selection.promote_pending();
        assert!(selection.update_drag_painted(&runs, (1, 10)));
        assert_eq!(
            selection.selected_text().as_deref(),
            Some("first line\nsecond line\nthird line")
        );
        for key in ["first", "second", "third"] {
            assert!(selection.wash_range(key).is_some(), "{key} is washed");
        }
    }

    #[test]
    fn a_drag_from_a_later_run_up_into_a_lifted_run_is_reversed() {
        let (elements, positions) = lifted_first();
        let runs = painted(&elements, &positions);
        let mut selection = SelectionState::default();
        selection.arm("third", 5);
        selection.promote_pending();
        // The head is in the middle of "first", which is painted last.
        assert!(selection.update_drag_painted(&runs, (2, 6)));
        assert_eq!(
            selection.selected_text().as_deref(),
            Some("line\nsecond line\nthird")
        );
        assert_eq!(selection.wash_range("first"), Some(6..10));
        assert_eq!(selection.wash_range("third"), Some(0..5));
    }

    #[test]
    fn a_sibling_that_a_removal_or_an_addition_moved_has_its_path_and_its_hosts_under_the_new_index() {
        let path = |path: &[u32]| DocPath::from(Arc::<[u32]>::from(path));
        let moved = path(&[0, 4, 9, 1]).moved_sibling(&[0, 4], 9, 8).expect("the sibling moves");
        assert_eq!(DocPos::new(moved, 0), DocPos::new(Arc::<[u32]>::from([0, 4, 8, 1]), 0));
        assert!(path(&[0, 4, 6, 1]).moved_sibling(&[0, 4], 9, 8).is_none(), "another sibling stays");
        assert!(path(&[0, 5, 9]).moved_sibling(&[0, 4], 9, 8).is_none(), "nor is what is under another parent");
        let hosted = DocPath::new(path(&[0, 1]).host(0, 3), Arc::from([0, 4, 9, 2]));
        let moved = hosted.moved_sibling(&[0, 4], 9, 10).expect("a text in a paragraph is put where its path is");
        assert_eq!(DocPos::new(moved, 0), DocPos::new(DocPath::new(path(&[0, 1]).host(0, 3), Arc::from([0, 4, 10, 2])), 0));
        let inside = DocPath::new(path(&[0, 4, 9]).host(0, 3), Arc::from([0, 4, 9, 2]));
        let moved = inside.moved_sibling(&[0, 4], 9, 10).expect("the paragraph it is hosted by is under the sibling");
        assert_eq!(DocPos::new(moved, 0), DocPos::new(DocPath::new(path(&[0, 4, 10]).host(0, 3), Arc::from([0, 4, 10, 2])), 0));
        assert_eq!(path(&[0, 4, 9]).parent_and_index(), Some((&[0, 4][..], 9)));
    }

    #[test]
    fn a_position_seen_from_its_root_is_the_same_wherever_the_root_is_and_comes_back_under_the_path_it_has() {
        let before = DocPath::from(Arc::<[u32]>::from([0, 4]));
        let after = DocPath::from(Arc::<[u32]>::from([0, 5]));
        let inside = DocPos::new(Arc::<[u32]>::from([0, 4, 2, 1]), 3);
        let relative = inside.relative_to(&before);
        assert_eq!(relative, DocPos::new(Arc::<[u32]>::from([2, 1]), 3));
        assert_eq!(relative.under(&before), inside);
        assert_eq!(relative.under(&after), DocPos::new(Arc::<[u32]>::from([0, 5, 2, 1]), 3), "a sibling inserted before moved the root");
        assert_eq!(DocPos::new(before.clone(), 0).relative_to(&before), DocPos::new(Arc::<[u32]>::from([]), 0), "the root's own text");
        assert!(after.relative_to(&after).under(&before).hosts.is_empty());
    }

    #[test]
    fn a_position_inside_a_box_of_a_paragraph_of_the_root_is_seen_from_the_root_in_every_level() {
        let root = DocPath::from(Arc::<[u32]>::from([1, 2]));
        let moved = DocPath::from(Arc::<[u32]>::from([1, 7]));
        let paragraph = DocPath::new(Arc::from([]), Arc::<[u32]>::from([1, 2, 0]));
        // What the renderer builds: the text in the box has the path the document has there, which starts with the paragraph's.
        let boxed = DocPos::new(DocPath::new(paragraph.host(0, 3), Arc::from([1, 2, 0, 0, 1])), 0);
        let relative = boxed.relative_to(&root);
        let expected = DocPath::from(Arc::<[u32]>::from([0])).host(0, 3);
        assert_eq!(relative, DocPos::new(DocPath::new(expected, Arc::from([0, 0, 1])), 0), "the host and the text are both seen from the root");
        assert_eq!(relative.under(&root), boxed);
        let moved_paragraph = DocPath::new(Arc::from([]), Arc::<[u32]>::from([1, 7, 0]));
        let moved_box = DocPos::new(DocPath::new(moved_paragraph.host(0, 3), Arc::from([1, 7, 0, 0, 1])), 0);
        assert_eq!(relative.under(&moved), moved_box, "a sibling inserted before the root moved the paragraph and the text in its box");
        assert!(relative.under(&moved) > DocPos::new(Arc::<[u32]>::from([1, 6, 9]), 0), "and it sorts after what is before the root now");
    }

    #[test]
    fn a_position_inside_a_box_in_a_box_is_seen_from_the_root_in_every_level() {
        let root = DocPath::from(Arc::<[u32]>::from([4]));
        let moved = DocPath::from(Arc::<[u32]>::from([5]));
        let outer = DocPath::from(Arc::<[u32]>::from([4, 1]));
        let inner = DocPath::new(outer.host(0, 2), Arc::from([4, 1, 0, 3]));
        let text = DocPos::new(DocPath::new(inner.host(1, 6), Arc::from([4, 1, 0, 3, 0, 2])), 0);
        let relative = text.relative_to(&root);
        assert_eq!(relative.depth(), 2);
        assert_eq!(relative.under(&root), text);
        let after = relative.under(&moved);
        assert_eq!(after.depth(), 2);
        assert!(after > text, "it is where the root is now, in each paragraph of the way");
        assert_eq!(after.relative_to(&moved), relative, "and seen from the root it is as it was");
    }

    #[test]
    fn a_root_inside_a_box_keeps_the_paragraphs_around_it_out_of_its_positions() {
        let paragraph = DocPath::from(Arc::<[u32]>::from([3]));
        let root = DocPath::new(paragraph.host(0, 5), Arc::from([0, 2]));
        let text = DocPos::new(DocPath::new(paragraph.host(0, 5), Arc::from([0, 2, 1])), 0);
        let relative = text.relative_to(&root);
        assert_eq!(relative, DocPos::new(Arc::<[u32]>::from([1]), 0));
        let elsewhere = DocPath::new(DocPath::from(Arc::<[u32]>::from([4])).host(0, 5), Arc::from([0, 2]));
        assert_eq!(relative.under(&elsewhere).depth(), 1);
    }

    /// `AA <box>BB</box> CC`, then a block `DD`: the paragraph is one painted string with the
    /// placeholder of the box in it, the box's text is hosted by the paragraph at that byte, and
    /// the paragraph paints first. Registry (paint) order: paragraph, box, block.
    fn around_a_box() -> (Vec<RegisteredText<'static>>, Vec<DocPos>) {
        let paragraph = DocPath::from(Arc::<[u32]>::from([0]));
        let hosts = paragraph.host(0, 3);
        (
            vec![
                on_line("p", "AA \u{FFFC} CC", "p"),
                on_line("box", "BB", "p"),
                reg("after", "DD", None),
            ],
            vec![
                DocPos::new(paragraph, 0),
                DocPos::new(DocPath::new(hosts, Arc::from([0])), 0),
                at(&[1], 0),
            ],
        )
    }

    fn dragged(down: (&str, usize), head: (usize, usize)) -> SelectionState {
        let (elements, positions) = around_a_box();
        let mut selection = SelectionState::default();
        selection.arm(down.0, down.1);
        selection.promote_pending();
        assert!(selection.update_drag_painted(&painted(&elements, &positions), head));
        selection
    }

    #[test]
    fn a_box_in_a_paragraph_falls_between_the_text_before_and_after_it() {
        // Down at the start of the paragraph, up at the end of the block after it.
        let selection = dragged(("p", 0), (2, 2));
        assert_eq!(selection.selected_text().as_deref(), Some("AA BB CC\nDD"));
        assert_eq!(selection.wash_ranges("p"), vec![0..3, 6..9]);
        assert_eq!(selection.wash_ranges("box"), vec![0..2]);
        assert_eq!(selection.wash_ranges("after"), vec![0..2]);
    }

    #[test]
    fn a_drag_from_inside_the_box_copies_the_rest_of_the_line_after_it() {
        let selection = dragged(("box", 1), (2, 1));
        assert_eq!(selection.selected_text().as_deref(), Some("B CC\nD"));
        assert_eq!(selection.wash_ranges("p"), vec![6..9]);
    }

    #[test]
    fn a_reversed_drag_from_after_the_box_up_into_it() {
        // Down in " CC" after the box, up in the middle of the box.
        let selection = dragged(("p", 8), (1, 1));
        assert_eq!(selection.selected_text().as_deref(), Some("B C"));
        assert_eq!(selection.wash_ranges("p"), vec![6..8]);
        assert_eq!(selection.wash_ranges("box"), vec![1..2]);
    }

    #[test]
    fn a_drag_inside_the_text_before_the_box_does_not_reach_it() {
        let selection = dragged(("p", 0), (0, 2));
        assert_eq!(selection.selected_text().as_deref(), Some("AA"));
        assert_eq!(selection.wash_ranges("box"), Vec::<Range<usize>>::new());
    }

    #[test]
    fn a_head_on_the_placeholder_belongs_to_the_text_before_it() {
        let selection = dragged(("p", 0), (0, 4));
        assert_eq!(selection.selected_text().as_deref(), Some("AA "));
    }

    #[test]
    fn two_boxes_in_a_row_and_a_box_with_a_line_of_its_own() {
        // `<box>1</box><box>2</box>` and the block after: no breaks inside the line.
        let line = DocPath::from(Arc::<[u32]>::from([0]));
        let elements = [
            on_line("p", "\u{FFFC}\u{FFFC}", "p"),
            on_line("one", "1", "p"),
            on_line("two", "2", "p"),
            reg("after", "DD", None),
        ];
        let positions = [
            DocPos::new(line.clone(), 0),
            DocPos::new(DocPath::new(line.host(0, 0), Arc::from([0])), 0),
            DocPos::new(DocPath::new(line.host(0, 3), Arc::from([0])), 0),
            at(&[1], 0),
        ];
        let mut selection = SelectionState::default();
        selection.arm("one", 0);
        selection.promote_pending();
        assert!(selection.update_drag_painted(&painted(&elements, &positions), (3, 2)));
        assert_eq!(selection.selected_text().as_deref(), Some("12\nDD"));
    }

    #[test]
    fn a_box_with_blocks_of_its_own_keeps_their_line_breaks() {
        let line = DocPath::from(Arc::<[u32]>::from([0]));
        let hosts = line.host(0, 2);
        let elements = [
            on_line("p", "a \u{FFFC} c", "p"),
            reg("x", "x", None),
            reg("y", "y", None),
        ];
        let positions = [
            DocPos::new(line, 0),
            DocPos::new(DocPath::new(hosts.clone(), Arc::from([0])), 0),
            DocPos::new(DocPath::new(hosts, Arc::from([1])), 0),
        ];
        let mut selection = SelectionState::default();
        selection.arm("p", 0);
        selection.promote_pending();
        assert!(selection.update_drag_painted(&painted(&elements, &positions), (0, 8)));
        assert_eq!(selection.selected_text().as_deref(), Some("a \nx\ny\n c"));
    }

    #[test]
    fn a_text_in_a_box_sorts_by_the_byte_of_its_placeholder() {
        let path = DocPath::from(Arc::<[u32]>::from([2]));
        let first = DocPos::new(DocPath::new(path.host(0, 3), Arc::from([0])), 0);
        let second = DocPos::new(DocPath::new(path.host(0, 9), Arc::from([0])), 0);
        let run = DocPos::new(path, 0);
        assert!(run.at(0) < first && first < run.at(4) && run.at(4) < second && second < run.at(10));
    }

    #[test]
    fn a_head_outside_the_registry_resolves_nothing() {
        let (elements, positions) = lifted_first();
        let runs = painted(&elements, &positions);
        let mut selection = SelectionState::default();
        selection.arm("first", 0);
        selection.promote_pending();
        assert!(!selection.update_drag_painted(&runs, (7, 0)));
    }
}
