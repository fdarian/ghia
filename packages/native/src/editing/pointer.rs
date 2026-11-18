//! The pointer in an editing host: a press puts the caret where it landed, a drag extends the
//! selection, and a double or triple click selects a word or a block.
//!
//! Native only finds where the pointer is in the DOM: the painted text knows which character is under a
//! window point, and JS owns the `Selection` (`js/editing/pointer-selection.ts`). Each phase is one
//! internal sync event aimed at the host, `editpointer`, that no listener hears: `inputType` is the
//! phase (`press`, `down`, `drag`, `up`), `detail` the click count of a `down`, `shiftKey` whether Shift was held,
//! and `editRange` the DOM position under the pointer as a collapsed range
//! (`[node, offset, node, offset]`), absent where the host paints no text.
//!
//! **The press is emitted from `PointerDispatch::press`,** after `mousedown`, because only there is the
//! verdict of the page known: a prevented `mousedown` starts nothing. It goes in two steps, as in Blink,
//! which focuses with the selection untouched and then places the caret: `press` at once, which only tells
//! JS that the focus the default of this press moves into the host is a pointer's (no caret at the start of
//! the host), and `down` deferred behind the focus default, so a `focus` or `focusin` listener sees the
//! selection the press found. The drag and the release are
//! emitted from the window-level listeners of the painted selection (`text/paint.rs`), which hand the
//! drag to this module while it holds one and then never touch the painted selection: the two never
//! select at once.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use gpui::{App, MouseMoveEvent, Pixels, Point, Window};

use super::geometry;
use crate::events::sync_dispatch;
use crate::renderer::EventCallback;
use crate::retained_tree::RetainedTree;

/// The internal event a press, drag or release in an editing host reaches JS as.
pub const EDIT_POINTER_EVENT: &str = "editpointer";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Press,
    Down,
    Drag,
    Up,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Press => "press",
            Phase::Down => "down",
            Phase::Drag => "drag",
            Phase::Up => "up",
        }
    }
}

/// The DOM position a pointer event named: a text node and a UTF-16 offset into it.
type Place = Option<(u64, usize)>;

struct Drag {
    host: u64,
    /// What the last event of the drag named, so that a move that stays on one character sends nothing.
    last: Place,
}

/// What the view keeps of the press that is down: the host it began in. It lives as long as the view, and the
/// listeners of each frame hold it through an [`EditingPointer`].
#[derive(Default)]
pub struct EditingPointerState {
    drag: RefCell<Option<Drag>>,
}

#[derive(Clone)]
pub struct EditingPointer {
    state: Rc<EditingPointerState>,
    tree: Arc<Mutex<RetainedTree>>,
    callback: Option<EventCallback>,
}

/// The editing host a press on `path` (the target first, then its ancestors) is in, when the press
/// is what puts the caret in it: the first element that takes focus on the way up is the host
/// itself, so a press on a button or an input in an island is not.
fn host_of(tree: &RetainedTree, path: &[u64]) -> Option<u64> {
    let focus = path.iter().find(|id| tree.focusable_ids.contains(id))?;
    crate::html::editing::is_editing_host(tree, *focus).then_some(*focus)
}

impl EditingPointer {
    pub fn new(state: Rc<EditingPointerState>, tree: Arc<Mutex<RetainedTree>>, callback: Option<EventCallback>) -> Self {
        Self { state, tree, callback }
    }

    fn place(&self, window: &Window, host: u64, position: Point<Pixels>) -> Place {
        let tree = self.tree.lock().unwrap();
        geometry::caret_position_in_host(&tree, window.window_handle().window_id(), host, f64::from(f32::from(position.x)), f64::from(f32::from(position.y)))
            .map(|point| (point.node_id as u64, point.offset as usize))
    }

    fn emit(&self, phase: Phase, host: u64, place: Place, click_count: u32, shift: bool, window: &mut Window, cx: &mut App) {
        sync_dispatch::emit_full(window, cx, &self.callback, host, EDIT_POINTER_EVENT, |payload| {
            payload.input_type = Some(phase.name().to_string());
            payload.detail = Some(click_count);
            payload.shift_key = Some(shift);
            payload.edit_range = place.map(|(node, offset)| vec![node as f64, offset as f64, node as f64, offset as f64]);
        });
    }

    /// A left press that `mousedown` did not cancel, on `path`. Returns whether it is in an editing host,
    /// which then owns the drag that follows.
    pub(crate) fn pressed(&self, path: &[u64], position: Point<Pixels>, click_count: u32, shift: bool, window: &mut Window, cx: &mut App) -> bool {
        let host = host_of(&self.tree.lock().unwrap(), path);
        let Some(host) = host else {
            self.state.drag.borrow_mut().take();
            return false;
        };
        self.emit(Phase::Press, host, None, 0, shift, window, cx);
        let this = self.clone();
        // Queued after the focus default of this press (`defer_mouse_down_default`), which the caller queued first.
        window.defer(cx, move |window, cx| {
            let place = this.place(window, host, position);
            *this.state.drag.borrow_mut() = Some(Drag { host, last: place });
            this.emit(Phase::Down, host, place, click_count, shift, window, cx);
        });
        true
    }

    /// Forgets the press that was down: a press that `mousedown` cancelled, or one outside a host, starts
    /// no drag of ours.
    pub(crate) fn cancelled(&self) {
        self.state.drag.borrow_mut().take();
    }

    /// A move of the window's pointer. Returns whether a drag in a host has it: the painted selection
    /// leaves it alone. A move with the button up means the release was missed, which ends the drag.
    pub fn moved(&self, event: &MouseMoveEvent, window: &mut Window, cx: &mut App) -> bool {
        let Some((host, last)) = self.state.drag.borrow().as_ref().map(|drag| (drag.host, drag.last)) else {
            return false;
        };
        if !event.dragging() {
            self.released(window, cx);
            return false;
        }
        let place = self.place(window, host, event.position);
        if place == last {
            return true;
        }
        if let Some(drag) = self.state.drag.borrow_mut().as_mut() {
            drag.last = place;
        }
        self.emit(Phase::Drag, host, place, 0, event.modifiers.shift, window, cx);
        true
    }

    /// The release of the left button. Returns whether a drag in a host ended with it. The last `drag` already
    /// put the selection where the pointer is, so `up` names no position.
    pub fn released(&self, window: &mut Window, cx: &mut App) -> bool {
        let Some(drag) = self.state.drag.borrow_mut().take() else {
            return false;
        };
        self.emit(Phase::Up, drag.host, None, 0, false, window, cx);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> RetainedTree {
        let mut tree = RetainedTree::new();
        for (id, kind) in [(1, "div"), (2, "div"), (3, "div"), (4, "div"), (5, "button"), (6, "div")] {
            tree.create_element(id, kind.to_string());
        }
        // 1 > 2 (host) > 3 (paragraph), 4 (island) > 5 (button); 6 beside the host.
        for (parent, child) in [(1, 2), (2, 3), (2, 4), (4, 5), (1, 6)] {
            tree.append_child(parent, child);
        }
        tree.set_custom_prop(2, "contentEditable".to_string(), serde_json::json!(true));
        tree.set_custom_prop(4, "contentEditable".to_string(), serde_json::json!(false));
        tree
    }

    #[test]
    fn a_press_in_the_host_or_on_text_of_an_island_is_the_hosts() {
        let tree = tree();
        assert_eq!(host_of(&tree, &[3, 2, 1]), Some(2));
        assert_eq!(host_of(&tree, &[4, 2, 1]), Some(2));
        assert_eq!(host_of(&tree, &[2, 1]), Some(2));
    }

    #[test]
    fn a_press_outside_a_host_or_on_a_control_inside_an_island_is_not() {
        let tree = tree();
        assert_eq!(host_of(&tree, &[6, 1]), None);
        assert_eq!(host_of(&tree, &[1]), None);
        assert_eq!(host_of(&tree, &[]), None);
        assert_eq!(host_of(&tree, &[5, 4, 2, 1]), None, "the button takes the focus, so it is the press's");
    }
}
