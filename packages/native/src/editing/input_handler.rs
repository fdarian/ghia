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
//! positions, when the platform gave one.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::{Arc, Mutex};

use gpui::{canvas, px, AnyElement, App, Bounds, FocusHandle, InputHandler, IntoElement, Pixels, Point, Styled, UTF16Selection, Window};

use super::snapshot::Snapshot;
use crate::events::sync_dispatch;
use crate::renderer::EventCallback;
use crate::retained_tree::RetainedTree;

/// The internal event an edit of the platform's text input reaches JS as. It is not a DOM event, and
/// no listener hears it.
pub const EDIT_INPUT_EVENT: &str = "editinput";

#[derive(Clone, Copy)]
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

    fn send(&self, kind: Kind, range: Option<Range<usize>>, text: &str, window: &mut Window, cx: &mut App) {
        let replacing = match range {
            Some(range) => match self.snapshot().and_then(|snapshot| snapshot.dom_range(&range)) {
                Some(points) => Some(points),
                None => {
                    sync_dispatch::report_deferred_error(format!(
                        "The input method named the range {}..{}, which is not in the text of the editing host",
                        range.start, range.end
                    ));
                    return;
                }
            },
            None => None,
        };
        sync_dispatch::emit_full(window, cx, &self.callback, self.host, EDIT_INPUT_EVENT, |payload| {
            payload.input_type = Some(kind.name().to_string());
            payload.data = Some(text.to_string());
            payload.edit_range = replacing.map(|(start, end)| vec![start.node as f64, start.offset as f64, end.node as f64, end.offset as f64]);
        });
    }
}

impl InputHandler for EditingInputHandler {
    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut App) -> Option<UTF16Selection> {
        let snapshot = self.snapshot()?;
        Some(UTF16Selection { range: snapshot.selection(), reversed: snapshot.is_reversed() })
    }

    fn marked_text_range(&mut self, _: &mut Window, _: &mut App) -> Option<Range<usize>> {
        None
    }

    fn text_for_range(&mut self, range: Range<usize>, adjusted: &mut Option<Range<usize>>, _: &mut Window, _: &mut App) -> Option<String> {
        let snapshot = self.snapshot()?;
        let range = range.start.min(snapshot.len())..range.end.min(snapshot.len());
        let text = snapshot.text_in(&range);
        *adjusted = Some(range);
        Some(text)
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, window: &mut Window, cx: &mut App) {
        self.send(Kind::Insert, range, text, window, cx);
    }

    fn replace_and_mark_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, _: Option<Range<usize>>, window: &mut Window, cx: &mut App) {
        self.send(Kind::Mark, range, text, window, cx);
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut App) {
        self.send(Kind::Unmark, None, "", window, cx);
    }

    fn bounds_for_range(&mut self, _: Range<usize>, _: &mut Window, _: &mut App) -> Option<Bounds<Pixels>> {
        None
    }

    fn character_index_for_point(&mut self, _: Point<Pixels>, _: &mut Window, _: &mut App) -> Option<usize> {
        None
    }
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
