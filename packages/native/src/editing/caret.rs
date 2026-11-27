//! The caret of an editing host, as native paints it.
//!
//! The node selection says where it is (`node_selection::NodeSelection::caret_byte`); this is whether it
//! is shown, and its blink. The paragraph that holds the caret paints it after its glyphs
//! (`text::paint::SelectableText`) through `Window::paint_caret`, which blinks it: on a layer of the
//! compositor, or lit and transparent in the frames of the window. Only when the window cannot (it says so
//! as it paints) does this tick: the caret is painted in the phase it is in, in no colour while it is off,
//! so that the operations of the paragraph are the same in both and a tick that paints it again is a patch.
//! That paragraph's container is what the blink is noted on (`Retain::blinks`): a unit that a tick builds
//! alone, as the editor of an `<input>` is. The clock is the one of the input, [`crate::caret`]; the state
//! is the view's, as the input's is its editor's, and is solid again whenever the selection changes or the
//! caret comes into view.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use gpui::{
    canvas, div, point, px, until_phase_change, AnyElement, App, Bounds, Context, FocusHandle, Hsla, IntoElement, ParentElement, Pixels, SharedString, Styled, Task,
    TextLayout, WeakEntity, Window, WindowId,
};
use web_time::Instant;

use super::geometry::window_box;
use crate::automation::window_point_from;
use crate::caret::{caret_rect, CARET_WIDTH};
use crate::renderer::GpuixView;
use crate::retain::Retain;
use crate::retained_tree::RetainedTree;
use crate::text::inline::{Child, Paragraph};

pub struct EditingCaret {
    pub color: Hsla,
    /// What the node selection was when the clock last started, and whether the caret was shown then.
    seen_generation: Cell<u64>,
    was_shown: Cell<bool>,
    anchor: Cell<Option<Instant>>,
    /// The container that painted the caret last, and whether it showed it: a container that painted
    /// it in the other state is due, which is how the caret comes with focus and goes with it.
    holder: Cell<Option<u64>>,
    painted_shown: Cell<bool>,
    /// The caret changed phase after it was painted last: only a paint of it clears it.
    timer_due: Cell<bool>,
    /// A task is waiting for the caret to change phase, which only a window that cannot blink it has.
    armed: Cell<bool>,
    task: RefCell<Option<Task<()>>>,
    /// The view that says whether the caret is shown, which the task asks when it wakes.
    view: RefCell<Option<WeakEntity<GpuixView>>>,
}

thread_local! {
    /// By window: when the blink of the caret it last painted restarted. Not in the registered text with
    /// the rest of what it painted, since a replay of a paragraph puts back the writes of the paint it was
    /// recorded from, which a tick since has changed.
    static ANCHOR: RefCell<HashMap<WindowId, Instant>> = RefCell::new(HashMap::new());
}

/// Whether `window` paints its editing caret in the lit phase of its blink at `now`: the answer of the clock
/// the window blinks it by, whether a layer of the compositor shows it or the frames do. `None` when it
/// paints none.
pub fn painted_lit(window: WindowId, now: Instant) -> Option<bool> {
    let anchor = ANCHOR.with(|anchors| anchors.borrow().get(&window).copied())?;
    Some(gpui::caret_visible(now.saturating_duration_since(anchor)))
}

fn note_anchor(window: WindowId, anchor: Option<Instant>) {
    ANCHOR.with(|all| match anchor {
        Some(anchor) => {
            all.borrow_mut().insert(window, anchor);
        }
        None => {
            all.borrow_mut().remove(&window);
        }
    });
}

impl EditingCaret {
    pub fn new(color: Hsla) -> Rc<Self> {
        Rc::new(Self {
            color,
            seen_generation: Cell::new(0),
            was_shown: Cell::new(false),
            anchor: Cell::new(None),
            holder: Cell::new(None),
            painted_shown: Cell::new(false),
            timer_due: Cell::new(false),
            armed: Cell::new(false),
            task: RefCell::new(None),
            view: RefCell::new(None),
        })
    }

    /// Called by the frame before it is built, with what the selection and the focus are now: the caret
    /// is solid from now when the selection changed or the caret came into view, and the task that
    /// waited for the end of the phase it was in is dropped, so the build aims another at the new one.
    pub fn sync(&self, window: WindowId, generation: u64, shown: bool, now: Instant) {
        let moved = self.seen_generation.replace(generation) != generation;
        if moved {
            EMPTY_LINE.with(|painted| painted.borrow_mut().remove(&window));
            note_anchor(window, None);
        }
        let came = shown && !self.was_shown.replace(shown);
        self.was_shown.set(shown);
        if moved {
            self.holder.set(None);
        }
        if moved || came || self.anchor.get().is_none() {
            self.anchor.set(Some(now));
            self.timer_due.set(false);
            self.armed.set(false);
            self.task.borrow_mut().take();
        }
    }

    pub(crate) fn anchor(&self) -> Instant {
        self.anchor.get().expect("sync starts the clock before anything is painted")
    }

    /// Whether the container `id` has to paint the caret again: its phase changed, or it painted it
    /// shown or hidden and the caret is the other now.
    pub fn due(&self, id: u64, shown: bool) -> bool {
        self.holder.get() == Some(id) && (self.timer_due.get() || self.painted_shown.get() != shown)
    }

    /// The window stopped blinking the caret: the container that paints it has to paint it again.
    pub fn repaint(&self) {
        self.timer_due.set(true);
    }

    pub fn blink_due(&self, shown: bool, window: &mut Window) -> bool {
        if !shown {
            self.armed.set(false);
            return false;
        }
        self.timer_due.set(true);
        window.request_tick();
        true
    }

    /// Keeps a task waiting for the caret to change phase, for a caret the window cannot blink
    /// (`Window::paint_caret` said so as it was painted): a caret nobody can see asks for no frame, and
    /// neither does one the window blinks. The change is a tick of the window, see
    /// `CustomElement::follows_clock`.
    fn keep_blinking(self: &Rc<Self>, window: &Window, cx: &App) {
        if self.armed.replace(true) {
            return;
        }
        let this: Weak<Self> = Rc::downgrade(self);
        *self.task.borrow_mut() = Some(window.spawn(cx, async move |cx| loop {
            let Some(caret) = this.upgrade() else { return };
            let wait = until_phase_change(cx.background_executor().now().saturating_duration_since(caret.anchor()));
            let view = caret.view.borrow().clone().expect("a caret that ticks was given its view by the build");
            drop(caret);
            cx.background_executor().timer(wait).await;
            let Some(caret) = this.upgrade() else { return };
            let kept = view.update_in(cx, |view, window, _| caret.blink_due(view.editing_caret_shown(window), window));
            if !matches!(kept, Ok(true)) {
                return;
            }
        }));
    }

    /// The caret needs no tick: the window blinks it, or it is not shown.
    fn stop_blinking(&self) {
        self.armed.set(false);
        self.task.borrow_mut().take();
    }
}

/// What a paragraph that holds the caret is given to paint it with.
#[derive(Clone)]
pub struct CaretPaint {
    pub holder: u64,
    pub byte: usize,
    pub shown: bool,
    pub state: Rc<EditingCaret>,
}

impl CaretPaint {
    /// Notes on the container being built that the caret blinks in it, held shown or not: what makes it
    /// due is the focus coming or going, as well as the clock of a window that cannot blink it.
    pub fn follow_clock(&self, retain: &mut Retain, cx: &mut Context<GpuixView>) {
        retain.blinks();
        *self.state.view.borrow_mut() = Some(cx.weak_entity());
    }

    /// Notes that the paragraph paints the caret now, in the paint that registers its text, and says where
    /// it is, in the space of the layout, as tall as its row. `None` when it is not shown. The caret is
    /// painted by [`Self::paint`], after the glyphs.
    pub fn locate(&self, layout: &TextLayout, window: &Window) -> Option<Bounds<Pixels>> {
        self.state.holder.set(Some(self.holder));
        self.state.painted_shown.set(self.shown);
        self.state.timer_due.set(false);
        let id = window.window_handle().window_id();
        if !self.shown {
            note_anchor(id, None);
            return None;
        }
        let position = layout.position_for_index(self.byte)?;
        let row = layout.row_for_index(self.byte)?;
        note_anchor(id, Some(self.state.anchor()));
        Some(caret_rect(point(position.x, row.top), row.height))
    }

    /// Paints the caret `locate` found, above the glyphs. The window blinks it; when it cannot, this
    /// paints it in the phase it is in and the caret ticks until it is painted again.
    pub fn paint(&self, rect: Bounds<Pixels>, window: &mut Window, cx: &App) {
        // A patch paints the paragraph alone, outside the effect group around it, so `paint_caret` does not
        // always know that the window cannot blink the caret: what it presented says.
        if window.paint_caret(rect, self.state.color, self.state.anchor()) || window.caret_needs_ticks() {
            self.state.keep_blinking(window, cx);
        } else {
            self.state.stop_blinking();
        }
    }
}

/// Whether the caret of the node selection of `tree` is painted: its editing host has focus and the
/// window is key.
pub fn is_shown(tree: &RetainedTree, focus_handles: &HashMap<u64, FocusHandle>, window: &Window) -> bool {
    tree.node_selection.caret().is_some_and(|caret| {
        window.is_window_active() && focus_handles.get(&caret.host).is_some_and(|handle| handle.is_focused(window))
    })
}

/// What `paragraph` paints of the caret, if the caret is in it.
pub fn held_by(
    state: &Rc<EditingCaret>,
    tree: &RetainedTree,
    focus_handles: &HashMap<u64, FocusHandle>,
    paragraph: &Paragraph,
    window: &Window,
) -> Option<CaretPaint> {
    let byte = tree.node_selection.caret_byte(tree, paragraph)?;
    Some(CaretPaint {
        holder: paragraph.container,
        byte,
        shown: is_shown(tree, focus_handles, window),
        state: state.clone(),
    })
}

/// The caret of a block whose only content is a line break (`<p><br></p>`, which an editor uses for an empty
/// line). That is a `Child::EmptyLine`: it has no paragraph, so no text to put the caret at and no row to
/// measure, and its block has no height. The caret is drawn at the start of the block, as tall as the line
/// its text style gives.
pub fn held_by_empty_line(
    state: &Rc<EditingCaret>,
    tree: &RetainedTree,
    focus_handles: &HashMap<u64, FocusHandle>,
    container: u64,
    plan: &[(Child, u32)],
    at: usize,
    window: &Window,
) -> Option<CaretPaint> {
    let caret = tree.node_selection.caret()?;
    let element = tree.elements.get(&caret.at.node)?;
    if caret.at.node != container || crate::text::inline::is_raw_text(element) {
        return None;
    }
    let lines = |index: usize| matches!(plan[index].0, Child::EmptyLine | Child::BlankLine);
    let first = (0..plan.len()).find(|index| lines(*index))?;
    let in_a_paragraph = plan
        .iter()
        .any(|(child, _)| matches!(child, Child::Paragraph(paragraph) if tree.node_selection.caret_byte(tree, paragraph).is_some()));
    (first == at && !in_a_paragraph).then(|| CaretPaint {
        holder: container,
        byte: 0,
        shown: is_shown(tree, focus_handles, window),
        state: state.clone(),
    })
}

/// The line of a block whose only content is a line feed: no text, one line of the text style it is in.
pub fn blank_line() -> AnyElement {
    div().child(SharedString::default()).into_any_element()
}

/// The empty line, with the caret in it: `line` is what it is without one (a [`blank_line`], or nothing
/// for a line of no size), and a canvas at its start paints the caret as tall as the line of the text
/// style it is in.
pub fn empty_line(caret: CaretPaint, line: Option<AnyElement>) -> AnyElement {
    let at = canvas(
        |_, _, _| (),
        move |bounds, _, window, cx| {
            let height = window.text_system().line_height(&window.text_style(), window.rem_size(), window.scale_factor());
            caret.paint_empty_line(point(bounds.origin.x, bounds.origin.y), height, window, cx);
        },
    )
    .keeps_no_position()
    .absolute()
    .top(px(0.0))
    .left(px(0.0))
    .unlifted()
    .w(CARET_WIDTH)
    .h(px(0.0));
    div().relative().unlifted().children(line).child(at).into_any_element()
}

thread_local! {
    /// By window: where the caret of an empty line was last painted, in window coordinates. Cleared when
    /// the selection changes, as the caret it describes goes.
    static EMPTY_LINE: RefCell<HashMap<WindowId, Bounds<Pixels>>> = RefCell::new(HashMap::new());
}

/// Where `window` last painted the caret of an empty line, if it paints one now.
pub fn painted_empty_line(window: WindowId) -> Option<Bounds<Pixels>> {
    EMPTY_LINE.with(|painted| painted.borrow().get(&window).copied())
}

impl CaretPaint {
    fn paint_empty_line(&self, origin: gpui::Point<Pixels>, height: Pixels, window: &mut Window, cx: &App) {
        self.state.holder.set(Some(self.holder));
        self.state.painted_shown.set(self.shown);
        self.state.timer_due.set(false);
        let id = window.window_handle().window_id();
        if !self.shown {
            EMPTY_LINE.with(|painted| painted.borrow_mut().remove(&id));
            note_anchor(id, None);
            return;
        }
        let rect = caret_rect(origin, height);
        self.paint(rect, window, cx);
        let matrix = window.transform();
        let Some(rect) = window_box(rect, |corner| window_point_from(&matrix, corner)) else { return };
        EMPTY_LINE.with(|painted| painted.borrow_mut().insert(id, rect.bounds()));
        note_anchor(id, Some(self.state.anchor()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repainted_caret_makes_the_container_that_painted_it_due() {
        let caret = EditingCaret::new(gpui::black());
        caret.holder.set(Some(7));
        caret.painted_shown.set(true);
        assert!(!caret.due(7, true));
        caret.repaint();
        assert!(caret.due(7, true));
        assert!(!caret.due(8, true), "only the container that holds the caret");
    }
}
