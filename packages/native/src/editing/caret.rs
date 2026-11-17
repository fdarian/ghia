//! The caret of an editing host, as native paints it.
//!
//! The node selection says where it is (`node_selection::NodeSelection::caret_byte`); this is whether it
//! is shown, and its blink. The paragraph that holds the caret paints it (`text::paint::SelectableText`),
//! in both phases of the blink and in no colour while it is off, so that the operations of the paragraph
//! are the same in both and a tick that paints it again is a patch. That paragraph's container is what the
//! blink is noted on (`Retain::blinks`): a unit that a tick builds alone, as the editor of an `<input>` is.
//! The clock is the one of the input, [`crate::caret`]; the state is the view's, as the input's is its
//! editor's, and is solid again whenever the selection changes or the caret comes into view.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use gpui::{
    canvas, div, fill, point, px, size, transparent_black, AnyElement, Bounds, Context, FocusHandle, Hsla, IntoElement, ParentElement, Pixels, Styled, Task,
    TextLayout, Window, WindowId,
};
use web_time::Instant;

use crate::caret::{caret_rect, caret_visible, until_phase_change, CARET_WIDTH};
use crate::renderer::GpuixView;
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
    /// A task is waiting for the caret to change phase.
    armed: Cell<bool>,
    task: RefCell<Option<Task<()>>>,
}

thread_local! {
    /// By window: whether the last paint of the caret was in the phase that has a colour. Not in the
    /// registered text with the rest of what it painted, since a replay of a paragraph puts back the
    /// writes of the paint it was recorded from, which a tick since has changed.
    static LIT: RefCell<HashMap<WindowId, bool>> = RefCell::new(HashMap::new());
}

/// Whether `window` last painted its editing caret in the lit phase of its blink.
pub fn painted_lit(window: WindowId) -> Option<bool> {
    LIT.with(|lit| lit.borrow().get(&window).copied())
}

fn note_lit(window: WindowId, lit: Option<bool>) {
    LIT.with(|all| match lit {
        Some(lit) => {
            all.borrow_mut().insert(window, lit);
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
        })
    }

    /// Called by the frame before it is built, with what the selection and the focus are now: the caret
    /// is solid from now when the selection changed or the caret came into view, and the task that
    /// waited for the end of the phase it was in is dropped, so the build aims another at the new one.
    pub fn sync(&self, window: WindowId, generation: u64, shown: bool, now: Instant) {
        let moved = self.seen_generation.replace(generation) != generation;
        if moved {
            EMPTY_LINE.with(|painted| painted.borrow_mut().remove(&window));
            note_lit(window, None);
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

    fn elapsed_ms(&self, now: Instant) -> u64 {
        let anchor = self.anchor.get().expect("sync starts the clock before anything is painted");
        now.saturating_duration_since(anchor).as_millis() as u64
    }

    /// Whether the container `id` has to paint the caret again: its phase changed, or it painted it
    /// shown or hidden and the caret is the other now.
    pub fn due(&self, id: u64, shown: bool) -> bool {
        self.holder.get() == Some(id) && (self.timer_due.get() || self.painted_shown.get() != shown)
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

    /// Keeps a task waiting for the caret to change phase while it is shown, and none while it is not: a
    /// caret nobody can see asks for no frame. The change is a tick of the window, see
    /// `CustomElement::follows_clock`.
    pub fn keep_blinking(self: &Rc<Self>, window: &Window, cx: &mut Context<GpuixView>) {
        if self.armed.replace(true) {
            return;
        }
        let this: Weak<Self> = Rc::downgrade(self);
        *self.task.borrow_mut() = Some(cx.spawn_in(window, async move |view, cx| loop {
            let Some(caret) = this.upgrade() else { return };
            let wait = until_phase_change(caret.elapsed_ms(cx.background_executor().now()));
            drop(caret);
            cx.background_executor().timer(wait).await;
            let Some(caret) = this.upgrade() else { return };
            let kept = view.update_in(cx, |view, window, _| caret.blink_due(view.editing_caret_shown(window), window));
            if !matches!(kept, Ok(true)) {
                return;
            }
        }));
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
    /// Paints the caret at `byte` of `layout`, as tall as its row, in no colour while it is off. Returns
    /// where it is, in the space of the layout.
    pub fn paint(&self, layout: &TextLayout, window: &mut Window, now: Instant) -> Option<Bounds<Pixels>> {
        self.state.holder.set(Some(self.holder));
        self.state.painted_shown.set(self.shown);
        self.state.timer_due.set(false);
        let id = window.window_handle().window_id();
        if !self.shown {
            note_lit(id, None);
            return None;
        }
        let position = layout.position_for_index(self.byte)?;
        let row = layout.row_for_index(self.byte)?;
        let rect = caret_rect(point(position.x, row.top), row.height);
        let lit = caret_visible(self.state.elapsed_ms(now));
        window.paint_quad(fill(rect, if lit { self.state.color } else { transparent_black() }));
        note_lit(id, Some(lit));
        Some(rect)
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
    let lines = |index: usize| matches!(plan[index].0, Child::EmptyLine);
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

/// The empty line, with the caret in it: a block of no size, as it is without one, and a canvas at its start
/// that paints the caret as tall as the line of the text style it is in.
pub fn empty_line(caret: CaretPaint) -> AnyElement {
    let at = canvas(
        |_, _, _| (),
        move |bounds, _, window, cx| {
            let height = window.text_system().line_height(&window.text_style(), window.rem_size(), window.scale_factor());
            caret.paint_empty_line(point(bounds.origin.x, bounds.origin.y), height, window, cx.background_executor().now());
        },
    )
    .keeps_no_position()
    .absolute()
    .unlifted()
    .w(CARET_WIDTH)
    .h(px(0.0));
    div().relative().unlifted().child(at).into_any_element()
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
    fn paint_empty_line(&self, origin: gpui::Point<Pixels>, height: Pixels, window: &mut Window, now: Instant) {
        self.state.holder.set(Some(self.holder));
        self.state.painted_shown.set(self.shown);
        self.state.timer_due.set(false);
        let id = window.window_handle().window_id();
        if !self.shown {
            EMPTY_LINE.with(|painted| painted.borrow_mut().remove(&id));
            note_lit(id, None);
            return;
        }
        let rect = caret_rect(origin, height);
        let lit = caret_visible(self.state.elapsed_ms(now));
        window.paint_quad(fill(rect, if lit { self.state.color } else { transparent_black() }));
        let matrix = window.transform();
        let corners = [rect.origin, rect.top_right(), rect.bottom_left(), rect.bottom_right()]
            .map(|corner| crate::automation::window_point_from(&matrix, corner));
        let Some(corners) = corners.into_iter().collect::<Option<Vec<_>>>() else { return };
        let min = point(corners.iter().map(|c| c.x).fold(Pixels::MAX, Pixels::min), corners.iter().map(|c| c.y).fold(Pixels::MAX, Pixels::min));
        let max = point(corners.iter().map(|c| c.x).fold(Pixels::MIN, Pixels::max), corners.iter().map(|c| c.y).fold(Pixels::MIN, Pixels::max));
        let rect = Bounds::new(min, size(max.x - min.x, max.y - min.y));
        EMPTY_LINE.with(|painted| painted.borrow_mut().insert(id, rect));
        note_lit(id, Some(lit));
    }
}
