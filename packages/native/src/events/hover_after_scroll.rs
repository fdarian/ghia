//! When the hover under a still pointer follows a scroll.
//!
//! A scroll that moves content under a pointer that did not move does not recompute the hover, as
//! in Chrome (Blink's `MouseEventManager::MarkHoverStateDirty`): the hover is marked dirty and
//! follows at the next frame after
//!
//! - the end of the gesture: 500 ms after the last tick of a mouse wheel (the latch of the wheel
//!   transaction, [`gpui::WHEEL_LATCH_TIMEOUT`]), or 100 ms after a trackpad lift unless momentum
//!   comes. Momentum events are `Moved` and run the 500 ms again; GPUI does not carry macOS's
//!   momentum phase, so the quiet period ends a fling (deviations.md, Scroll);
//! - a scroll that code made (`scrollTop = n`, `scrollTo`, `scrollIntoView`, a key, a scrollbar, a
//!   row), when it has moved, or when its smooth animation ends;
//! - a build that changed the tree, a style or the layout, or that ran an animation of the layout
//!   (`LocalFrameView::PerformPostLayoutTasks`).
//!
//! A pointer that moved follows at once, as it does without a scroll.
//!
//! The state belongs to the view of the window and is shared with what reads it from the paint of the
//! pointer frame, the translate of a list and the render, none of which can reach the view that owns
//! the pointer state: the view is leased while they run.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{App, Window, WindowId};

use crate::scroll::Writes;

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
    /// The next frame follows the hover: a scroll that code made has moved, or its animation ended.
    due: Cell<bool>,
    /// A smooth scroll that code began is in flight: the hover follows when the window has none.
    smooth: Cell<bool>,
    /// The tree, a style or the layout changed since a frame last reached paint.
    build_changed: Cell<bool>,
    seen: Cell<Option<BuildSeen>>,
    wheel: Wheel,
    resync: RefCell<Option<Resync>>,
}

/// What a build reads that a scroll does not move.
#[derive(Clone, Copy, PartialEq)]
struct BuildSeen {
    revision: u64,
    viewport: (f32, f32),
}

/// The end of the wheel gesture in flight: one deadline, and the task that waits for it.
#[derive(Default)]
struct Wheel {
    /// When the gesture is over, moved by every wheel tick.
    deadline: Cell<Option<Instant>>,
    /// The wake of the task that waits, which is the deadline or an earlier time it was armed for.
    armed: Cell<Option<Instant>>,
    /// Counts the tasks armed, so one that was replaced does nothing when it wakes.
    generation: Cell<u64>,
}

/// What a task does when it wakes.
#[derive(Debug, PartialEq)]
enum Woke {
    /// It was replaced, or the gesture ended with the pointer moving.
    Done,
    /// The deadline moved later: wait for it.
    Wait(Instant),
    /// The gesture is over and nothing followed the hover since.
    Follow,
}

impl HoverAfterScroll {
    /// Gives the state what follows the hover: the paint of every frame's pointer frame says it again,
    /// for the observed chain that frame was built with.
    pub(crate) fn install(&self, resync: Resync) {
        *self.resync.borrow_mut() = Some(resync);
    }

    /// A wheel tick arrived. The scroll it causes is over once the wheel is quiet.
    pub(crate) fn note_wheel(self: &Rc<Self>, phase: &str, window: &Window, cx: &App) {
        let executor = cx.background_executor().clone();
        let Some((generation, wake)) = self.wheel_at(phase, executor.now()) else {
            return;
        };
        let state = self.clone();
        window
            .spawn(cx, async move |cx| {
                let mut wake = wake;
                loop {
                    executor.timer(wake.saturating_duration_since(executor.now())).await;
                    match state.woke(generation, executor.now()) {
                        Woke::Done => return,
                        Woke::Wait(later) => wake = later,
                        Woke::Follow => {
                            cx.update(|window, cx| state.follow(window, cx)).ok();
                            return;
                        }
                    }
                }
            })
            .detach();
    }

    /// A wheel tick at `now`: the generation and wake of the task to arm, or `None` when the one that
    /// waits wakes at the deadline or before it and moves on by itself.
    fn wheel_at(&self, phase: &str, now: Instant) -> Option<(u64, Instant)> {
        self.moved.set(true);
        let quiet = match phase {
            "ended" | "cancelled" => LIFT_SETTLE,
            _ => WHEEL_QUIET,
        };
        let deadline = now + quiet;
        self.wheel.deadline.set(Some(deadline));
        if self.wheel.armed.get().is_some_and(|armed| armed <= deadline) {
            return None;
        }
        self.wheel.armed.set(Some(deadline));
        let generation = self.wheel.generation.get().wrapping_add(1);
        self.wheel.generation.set(generation);
        Some((generation, deadline))
    }

    /// The task of `generation` woke at `now`.
    fn woke(&self, generation: u64, now: Instant) -> Woke {
        if generation != self.wheel.generation.get() {
            return Woke::Done;
        }
        match self.wheel.deadline.get() {
            Some(deadline) if deadline > now => {
                self.wheel.armed.set(Some(deadline));
                Woke::Wait(deadline)
            }
            _ => {
                self.wheel.deadline.set(None);
                self.wheel.armed.set(None);
                if self.moved.replace(false) { Woke::Follow } else { Woke::Done }
            }
        }
    }

    /// Takes what code scrolled in `window` since the last frame. An instant scroll is over, and the hover
    /// follows at the next frame; a smooth one is over when the window has no animation left.
    fn take_scrolls(&self, window: WindowId) {
        self.absorb(crate::scroll::take_writes(window), crate::scroll::animating_in(window));
    }

    fn absorb(&self, written: Writes, animating: bool) {
        if written.instant {
            self.moved.set(true);
            self.due.set(true);
        }
        if written.smooth {
            self.moved.set(true);
            self.smooth.set(true);
        }
        if self.smooth.get() && !animating {
            self.smooth.set(false);
            if self.moved.get() {
                self.due.set(true);
            }
        }
    }

    /// A pointer that moved has the hover it is over.
    pub(crate) fn pointer_moved(&self) {
        self.moved.set(false);
    }

    /// A frame is being built: `revision` is the tree's, and a layout animation has frames to run
    /// when `layout_animating`. A change of either, or of the size of the window, is a change to the
    /// page that the hover follows after. Motion that moves nothing a pointer is over (a color, an
    /// opacity, a transform) is not one.
    pub(crate) fn note_build(&self, revision: u64, viewport: (f32, f32), layout_animating: bool) {
        let seen = BuildSeen { revision, viewport };
        if layout_animating || self.seen.replace(Some(seen)) != Some(seen) {
            self.build_changed.set(true);
        }
    }

    /// A frame built whole of `window` has been painted: whether the hover follows it now. It does unless
    /// a scroll moved the content under the pointer and that scroll is the only thing the frame is for.
    pub(crate) fn follows_build(&self, window: WindowId) -> bool {
        self.take_scrolls(window);
        self.after_build()
    }

    fn after_build(&self) -> bool {
        let changed = self.build_changed.take();
        let due = self.due.take();
        self.follows(changed || due)
    }

    /// The rows of a list of `window` were moved in place, which builds nothing: whether the hover follows now.
    pub(crate) fn follows_translate(&self, window: WindowId) -> bool {
        self.take_scrolls(window);
        self.after_translate()
    }

    fn after_translate(&self) -> bool {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quiet() -> Writes {
        Writes::default()
    }

    fn instant() -> Writes {
        Writes { instant: true, smooth: false }
    }

    fn smooth() -> Writes {
        Writes { instant: false, smooth: true }
    }

    fn ms(count: u64) -> Duration {
        Duration::from_millis(count)
    }

    #[test]
    fn a_wheel_waits_for_its_quiet_and_then_follows() {
        let state = HoverAfterScroll::default();
        let start = Instant::now();
        let (generation, wake) = state.wheel_at("moved", start).expect("a task is armed");
        assert_eq!(wake, start + WHEEL_QUIET);
        // Frames built for the scroll leave the hover where it was.
        assert!(!state.after_build());
        assert!(!state.after_translate());
        assert_eq!(state.woke(generation, start + WHEEL_QUIET), Woke::Follow);
        assert!(state.after_translate(), "nothing is left to wait for");
    }

    #[test]
    fn ticks_move_one_deadline_and_arm_one_task() {
        let state = HoverAfterScroll::default();
        let start = Instant::now();
        let (generation, wake) = state.wheel_at("moved", start).expect("the first tick arms a task");
        for tick in 1..10 {
            assert_eq!(state.wheel_at("moved", start + ms(16 * tick)), None, "tick {tick} arms nothing");
        }
        // The task wakes at the first deadline, finds the wheel still running and waits for its end.
        assert_eq!(state.woke(generation, wake), Woke::Wait(start + ms(16 * 9) + WHEEL_QUIET));
        assert_eq!(state.woke(generation, start + ms(16 * 9) + WHEEL_QUIET), Woke::Follow);
    }

    #[test]
    fn a_trackpad_lift_follows_100_ms_later_not_at_the_end_of_the_latch() {
        let state = HoverAfterScroll::default();
        let start = Instant::now();
        let (first, _) = state.wheel_at("moved", start).expect("armed");
        let (lift, wake) = state.wheel_at("ended", start + ms(20)).expect("an earlier deadline arms a task of its own");
        assert_ne!(first, lift);
        assert_eq!(wake, start + ms(20) + LIFT_SETTLE);
        assert_eq!(state.woke(first, start + WHEEL_QUIET), Woke::Done, "the replaced task does nothing");
        assert_eq!(state.woke(lift, wake), Woke::Follow);
    }

    #[test]
    fn momentum_after_a_lift_runs_the_latch_again() {
        let state = HoverAfterScroll::default();
        let start = Instant::now();
        let (lift, wake) = state.wheel_at("ended", start).expect("armed");
        assert_eq!(state.wheel_at("moved", start + ms(50)), None, "momentum moves the deadline later");
        assert_eq!(state.woke(lift, wake), Woke::Wait(start + ms(50) + WHEEL_QUIET));
    }

    #[test]
    fn a_pointer_that_moved_is_not_followed_again_when_the_wheel_ends() {
        let state = HoverAfterScroll::default();
        let start = Instant::now();
        let (generation, wake) = state.wheel_at("moved", start).expect("armed");
        state.pointer_moved();
        assert!(state.after_translate(), "a pointer that moved follows at once");
        assert_eq!(state.woke(generation, wake), Woke::Done);
    }

    #[test]
    fn an_instant_write_follows_at_the_next_frame() {
        let state = HoverAfterScroll::default();
        state.absorb(instant(), false);
        assert!(state.after_build());
        assert!(state.after_translate(), "and it asked for nothing more");
    }

    #[test]
    fn a_smooth_write_follows_when_its_animation_ends() {
        let state = HoverAfterScroll::default();
        state.absorb(smooth(), true);
        assert!(!state.after_build());
        state.absorb(quiet(), true);
        assert!(!state.after_translate(), "it is still running");
        state.absorb(quiet(), false);
        assert!(state.after_translate());
    }

    #[test]
    fn a_smooth_write_does_not_take_back_an_instant_one_of_the_same_task() {
        let state = HoverAfterScroll::default();
        state.absorb(Writes { instant: true, smooth: true }, true);
        assert!(state.after_build(), "the instant write is due while the smooth one runs");
    }

    #[test]
    fn a_build_that_changed_the_page_follows_and_one_that_did_not_waits() {
        let state = HoverAfterScroll::default();
        let size = (800.0, 600.0);
        state.note_build(1, size, false);
        assert!(state.after_build(), "the first build is a change");
        assert!(state.after_build(), "no scroll moved anything");
        state.wheel_at("moved", Instant::now());
        state.note_build(1, size, false);
        assert!(!state.after_build(), "a scroll is all the frame is for");
        state.note_build(2, size, false);
        assert!(state.after_build(), "a commit follows");
        state.wheel_at("moved", Instant::now());
        state.note_build(2, (800.0, 700.0), false);
        assert!(state.after_build(), "a resize follows");
    }

    #[test]
    fn a_layout_animation_follows_every_frame_and_other_motion_does_not() {
        let state = HoverAfterScroll::default();
        let size = (800.0, 600.0);
        state.note_build(1, size, false);
        state.after_build();
        state.wheel_at("moved", Instant::now());
        state.note_build(1, size, true);
        assert!(state.after_build(), "a box that moves under the pointer");
        state.wheel_at("moved", Instant::now());
        state.note_build(1, size, false);
        assert!(!state.after_build(), "paint-only motion is not asked about");
    }
}
