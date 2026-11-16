//! When the hover under a still pointer follows a scroll.
//!
//! A scroll that moves content under a pointer that did not move does not recompute the hover, as
//! in Chrome (Blink's `MouseEventManager::MarkHoverStateDirty`): the hover is marked dirty and
//! follows at the next frame after
//!
//! - the end of the gesture: 500 ms after the last tick of a mouse wheel (the latch of the wheel
//!   transaction, [`gpui::WHEEL_LATCH_TIMEOUT`]), or 100 ms after a trackpad lift unless momentum
//!   comes (macOS reports `Ended` at the lift and nothing at the end of the momentum, whose events
//!   are `Moved` and so run the 500 ms again);
//! - a scroll that code wrote (`scrollTop = n`, `scrollTo`), when it has moved, or when its smooth
//!   animation ends;
//! - a build that changed the tree, a style or the layout (`LocalFrameView::PerformPostLayoutTasks`).
//!
//! A pointer that moved follows at once, as it does without a scroll.
//!
//! The state is per window and read from the paint of the pointer frame, the translate of a list
//! and the render, none of which can reach the view that owns the pointer state: the view is
//! leased while they run.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use gpui::{App, Window, WindowId};
use rustc_hash::FxHashMap;

/// How long after the finger leaves a trackpad that the hover follows, unless momentum scrolls on.
pub(crate) const LIFT_SETTLE: Duration = Duration::from_millis(100);

/// How long a mouse wheel is quiet before its scroll is over: GPUI's latch, the same transaction
/// Chrome ends a wheel gesture with.
pub(crate) const WHEEL_QUIET: Duration = gpui::WHEEL_LATCH_TIMEOUT;

type Resync = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(Default)]
pub(crate) struct HoverAfterScroll {
    /// Content moved under the pointer since the hover was last followed.
    moved: Cell<bool>,
    /// The next frame follows the hover: a scroll that code wrote has moved, or its animation ended.
    due: Cell<bool>,
    /// The tree, a style or the layout changed since a frame last reached paint.
    build_changed: Cell<bool>,
    seen: Cell<Option<BuildSeen>>,
    /// Counts the timers armed, so one that was replaced does nothing when it fires.
    generation: Cell<u64>,
    resync: RefCell<Option<Resync>>,
}

/// What a build reads that a scroll does not move.
#[derive(Clone, Copy, PartialEq)]
struct BuildSeen {
    revision: u64,
    viewport: (f32, f32),
}

thread_local! {
    static WINDOWS: RefCell<FxHashMap<WindowId, Rc<HoverAfterScroll>>> = RefCell::new(FxHashMap::default());
}

/// The state of `window`.
pub(crate) fn of(window: &Window) -> Rc<HoverAfterScroll> {
    let id = window.window_handle().window_id();
    WINDOWS.with(|windows| windows.borrow_mut().entry(id).or_default().clone())
}

impl HoverAfterScroll {
    /// Gives the state what follows the hover: the paint of every frame's pointer frame says it again,
    /// for the observed chain that frame was built with.
    pub(crate) fn install(&self, resync: Resync) {
        *self.resync.borrow_mut() = Some(resync);
    }

    /// A wheel tick arrived. The scroll it causes is over once the wheel is quiet.
    pub(crate) fn note_wheel(self: &Rc<Self>, phase: &str, window: &Window, cx: &App) {
        self.moved.set(true);
        let quiet = match phase {
            "ended" | "cancelled" => LIFT_SETTLE,
            _ => WHEEL_QUIET,
        };
        let generation = self.generation.get().wrapping_add(1);
        self.generation.set(generation);
        let state = self.clone();
        window
            .spawn(cx, async move |cx| {
                cx.background_executor().timer(quiet).await;
                cx.update(|window, cx| state.gesture_ended(generation, window, cx)).ok();
            })
            .detach();
    }

    /// Code wrote a scroll offset. An instant scroll is over, and the hover follows at the next frame; a
    /// smooth one is over when its animation ends (`animation_ended`).
    pub(crate) fn note_written(&self, smooth: bool) {
        self.moved.set(true);
        self.due.set(!smooth);
    }

    /// The smooth scrolls in flight have ended.
    pub(crate) fn animation_ended(&self) {
        if self.moved.get() {
            self.due.set(true);
        }
    }

    /// A pointer that moved has the hover it is over.
    pub(crate) fn pointer_moved(&self) {
        self.moved.set(false);
    }

    /// A frame is being built: `revision` is the tree's, and a layout animation has frames to run
    /// when `animating`. A change of either, or of the size of the window, is a change to the page
    /// that the hover follows after.
    pub(crate) fn note_build(&self, revision: u64, viewport: (f32, f32), animating: bool) {
        let seen = BuildSeen { revision, viewport };
        if animating || self.seen.replace(Some(seen)) != Some(seen) {
            self.build_changed.set(true);
        }
    }

    /// A frame built whole has been painted: whether the hover follows it now. It does unless a scroll
    /// moved the content under the pointer and that scroll is the only thing the frame is for.
    pub(crate) fn follows_build(&self) -> bool {
        let changed = self.build_changed.take();
        let due = self.due.take();
        self.follows(changed || due)
    }

    /// The rows of a list were moved in place, which builds nothing: whether the hover follows now.
    pub(crate) fn follows_translate(&self) -> bool {
        self.follows(self.due.take())
    }

    fn follows(&self, reason: bool) -> bool {
        // A frame that is for something else than a scroll follows the hover as every frame does, which
        // asks for nothing when the chain under the pointer is the one it had.
        let follows = reason || !self.moved.get();
        if follows {
            self.moved.set(false);
        }
        follows
    }

    /// Follows the hover: dispatches a resync, which does nothing if the chain under the pointer is the one the last input saw.
    pub(crate) fn follow(&self, window: &mut Window, cx: &mut App) {
        let resync = self.resync.borrow().clone().expect("a frame was painted before the hover follows");
        resync(window, cx);
    }

    fn gesture_ended(&self, generation: u64, window: &mut Window, cx: &mut App) {
        if generation != self.generation.get() || !self.moved.replace(false) {
            return;
        }
        self.follow(window, cx);
    }
}
