//! The platform's text input for a focused editing host.
//!
//! AppKit (and the test renderer's `dispatch_input`) hand typed text, an emoji, a dead key's result or
//! an input method's composition to the window's one input handler. An `<input>` registers its editor;
//! an editing host is a tree of elements whose text JS owns, so its handler answers from a
//! [`Snapshot`] of the node selection and sends each edit to JS, which makes it in the DOM
//! ([`js/editing/native-input.ts`]): `beforeinput`, the change, `input`.
//!
//! **Registration.** `Window::handle_input` registers during paint and only while the handle has focus,
//! and gpui keeps the last handler across frames that do not paint its element: the platform window
//! holds it, a frame that replays the paint of the element copies it, and a patch that repaints a unit
//! puts back the ones the unit held (`window.rs` `draw`, `reuse_paint_with`, `patch_splice.rs`
//! `register_input_handler`). So the host paints a [`layer`] only in the frames that build it, which
//! includes the frame after every change of its focus, and the handler holds nothing a later frame
//! could make stale: no bounds, no text, only where to read them.
//!
//! **The edit is JS's, and synchronous.** The handler sends `editinput` with `sync_dispatch::emit` and
//! JS has made the edit and flushed its mutations when it returns, so a query that follows (AppKit asks
//! for the selection after every insert) reads the new tree. Where no JS call is on the stack the event
//! is queued, with the DOM positions of a replacement range as they were when it was sent.
//!
//! What it sends is the `editinput` event: `inputType` is the kind (`insert`, `mark`, `unmark`), `data`
//! the text and `editRange` the replacement range as `[startNode, startOffset, endNode, endOffset]` DOM
//! positions (the platform's, else the marked text of a composition that runs), `isComposing` whether one
//! did, and `editSelection` where the selection goes in the text of a `mark`. The marked text itself is
//! [`super::composition`]'s; a queued edit (no JS on the stack) leaves it as it was when the platform asked.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::{Arc, Mutex};

use gpui::{canvas, point, px, size, AnyElement, App, Bounds, FocusHandle, InputHandler, IntoElement, Pixels, Point, Styled, UTF16Selection, Window, WindowId};

use super::composition::Marked;
use super::geometry;
use super::positions::{units_of, DomPoint};
use super::snapshot::{Edge, Snapshot};
use crate::events::sync_dispatch;
use crate::renderer::EventCallback;
use crate::retained_tree::RetainedTree;

/// The internal event an edit of the platform's text input reaches JS as. It is not a DOM event, and
/// no listener hears it.
pub const EDIT_INPUT_EVENT: &str = "editinput";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Insert,
    Mark,
    Unmark,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Insert => "insert",
            Kind::Mark => "mark",
            Kind::Unmark => "unmark",
        }
    }
}

pub struct EditingInputHandler {
    tree: Arc<Mutex<RetainedTree>>,
    callback: Option<EventCallback>,
    host: u64,
}

impl EditingInputHandler {
    fn snapshot(&self) -> Option<Snapshot> {
        let tree = self.tree.lock().unwrap();
        Snapshot::of(&tree, self.host)
    }

    /// The snapshot and the marked range in it, which a composition that does not hold the selection any
    /// more has none of.
    fn snapshot_and_marked(&self) -> (Option<Snapshot>, Option<Range<usize>>) {
        let tree = self.tree.lock().unwrap();
        let snapshot = Snapshot::of(&tree, self.host);
        let marked = tree.composition.range(self.host, snapshot.as_ref());
        (snapshot, marked)
    }

    /// One edit of the platform's text input, made in the DOM by JS before this returns (when JS is on the
    /// stack). It goes where the platform said, else into the marked text of a composition that runs, else
    /// where the selection is. `selected` is where the selection goes in the text of a `Mark`.
    fn send(&self, kind: Kind, range: Option<Range<usize>>, text: &str, selected: Option<Range<usize>>, window: &mut Window, cx: &mut App) {
        let (snapshot, marked) = self.snapshot_and_marked();
        let composing = marked.is_some();
        let replaced = range.or(marked);
        let replacing = match (&replaced, &snapshot) {
            (Some(range), snapshot) => match snapshot.as_ref().and_then(|snapshot| snapshot.dom_range(range)) {
                Some(points) => Some(points),
                None => {
                    sync_dispatch::report_deferred_error(format!(
                        "The input method named the range {}..{}, which is not in the text of the editing host",
                        range.start, range.end
                    ));
                    return;
                }
            },
            (None, _) => None,
        };
        sync_dispatch::emit_full(window, cx, &self.callback, self.host, EDIT_INPUT_EVENT, |payload| {
            payload.input_type = Some(kind.name().to_string());
            payload.data = Some(text.to_string());
            payload.is_composing = Some(composing);
            payload.edit_range = replacing.map(|(start, end)| vec![start.node as f64, start.offset as f64, end.node as f64, end.offset as f64]);
            payload.edit_selection = selected.as_ref().map(|selected| vec![selected.start as f64, selected.end as f64]);
        });
        let tree = self.tree.lock().unwrap();
        match kind {
            Kind::Insert | Kind::Unmark => tree.composition.end(),
            Kind::Mark => self.mark_after(&tree, text, selected),
        }
    }

    /// Marks the text a `Mark` put in, which sits where the selection is now: JS set it as the platform
    /// asked, `selected` of the text (its end when the platform did not say), so the text starts that far
    /// before it.
    fn mark_after(&self, tree: &RetainedTree, text: &str, selected: Option<Range<usize>>) {
        tree.composition.end();
        let units = units_of(text);
        if units == 0 {
            return;
        }
        let Some(snapshot) = Snapshot::of(tree, self.host) else { return };
        let selection = snapshot.selection();
        let inside = selected.map_or(units, |selected| selected.start);
        let Some(start) = selection.start.checked_sub(inside) else { return };
        let Some((from, to)) = snapshot.dom_range(&(start..start + units)) else { return };
        tree.composition.mark(Marked { host: self.host, start: from, end: to });
    }
}

impl InputHandler for EditingInputHandler {
    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut App) -> Option<UTF16Selection> {
        let snapshot = self.snapshot()?;
        Some(UTF16Selection { range: snapshot.selection(), reversed: snapshot.is_reversed() })
    }

    fn marked_text_range(&mut self, _: &mut Window, _: &mut App) -> Option<Range<usize>> {
        self.snapshot_and_marked().1
    }

    fn text_for_range(&mut self, range: Range<usize>, adjusted: &mut Option<Range<usize>>, _: &mut Window, _: &mut App) -> Option<String> {
        let snapshot = self.snapshot()?;
        let range = range.start.min(snapshot.len())..range.end.min(snapshot.len());
        let text = snapshot.text_in(&range);
        *adjusted = Some(range);
        Some(text)
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, window: &mut Window, cx: &mut App) {
        self.send(Kind::Insert, range, text, None, window, cx);
    }

    fn replace_and_mark_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, selected: Option<Range<usize>>, window: &mut Window, cx: &mut App) {
        self.send(Kind::Mark, range, text, selected, window, cx);
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut App) {
        self.send(Kind::Unmark, None, "", None, window, cx);
    }

    fn bounds_for_range(&mut self, range: Range<usize>, window: &mut Window, _: &mut App) -> Option<Bounds<Pixels>> {
        let snapshot = self.snapshot();
        let tree = self.tree.lock().unwrap();
        range_bounds(&tree, window.window_handle().window_id(), snapshot.as_ref(), &range)
    }

    fn character_index_for_point(&mut self, at: Point<Pixels>, window: &mut Window, _: &mut App) -> Option<usize> {
        let snapshot = self.snapshot()?;
        let tree = self.tree.lock().unwrap();
        index_at_point(&tree, window.window_handle().window_id(), &snapshot, at)
    }
}

fn number(value: Pixels) -> f64 {
    f64::from(f32::from(value))
}

/// Where the text of `range` of the snapshot is in the window: its first rect, and for no text (an
/// empty range) the caret of the line. A range that runs into another paragraph has the rect it has
/// in the one it starts in. An empty line has no text to be the rect of, so it is where its caret was
/// painted.
pub(crate) fn range_bounds(tree: &RetainedTree, window: WindowId, snapshot: Option<&Snapshot>, range: &Range<usize>) -> Option<Bounds<Pixels>> {
    let from_text = snapshot.and_then(|snapshot| {
        let caret = snapshot.point_at(range.start, Edge::Start)?;
        let rects = if range.is_empty() {
            geometry::text_range_rects(tree, window, caret, caret)
        } else {
            let (start, end) = snapshot.dom_range(range)?;
            geometry::text_range_rects(tree, window, start, end).or_else(|_| geometry::text_range_rects(tree, window, caret, caret))
        };
        let rect = rects.ok()?.into_iter().next()?;
        Some(Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.width as f32), px(rect.height as f32))))
    });
    from_text.or_else(|| {
        let line = super::caret::painted_empty_line(window)?;
        Some(Bounds::new(line.origin, size(Pixels::ZERO, line.size.height)))
    })
}

/// The offset in the snapshot of the character at the window point, `None` where the text under it is
/// not in the snapshot.
pub(crate) fn index_at_point(tree: &RetainedTree, window: WindowId, snapshot: &Snapshot, at: Point<Pixels>) -> Option<usize> {
    let found = geometry::caret_position_from_point(tree, window, number(at.x), number(at.y))?;
    snapshot.offset_of(DomPoint { node: found.node_id as u64, offset: found.offset as usize })
}

/// The element that registers the handler of `host` in the frames that build it: nothing while the host
/// has no focus. It is an absolutely placed canvas of no size, the last child of the host, so it
/// paints (and is replayed) with the host and adds nothing to the layout of its content.
pub fn layer(
    shared: &Arc<Mutex<RetainedTree>>,
    tree: &RetainedTree,
    host: u64,
    focus_handles: &HashMap<u64, FocusHandle>,
    callback: &Option<EventCallback>,
    window: &Window,
) -> Option<AnyElement> {
    let focus = focus_handles.get(&host).filter(|handle| handle.is_focused(window))?;
    if !crate::html::editing::is_editing_host(tree, host) {
        return None;
    }
    let focus = focus.clone();
    let handler = EditingInputHandler { tree: shared.clone(), callback: callback.clone(), host };
    Some(
        canvas(
            |_, _, _| (),
            move |_, _, window, cx| window.handle_input(&focus, handler, cx),
        )
        .keeps_no_position()
        .absolute()
        .top(px(0.0))
        .left(px(0.0))
        .unlifted()
        .w(px(0.0))
        .h(px(0.0))
        .into_any_element(),
    )
}
