//! The steps of "update the rendering" that run before a frame builds, so that what they change is
//! what that frame paints (`Window::set_frame_steps`, run first in `Window::draw`).
//!
//! In order: the writes recorded since the last render are made, smooth scrolls advance, and every
//! scroller whose offset differs from the one it last reported gets its `scroll` event, delivered
//! synchronously (`events::sync_dispatch`) so the mutations of a handler are in the tree this
//! draw builds. A scroll event is therefore never later than the frame that paints its offset, as
//! in a browser, where the `scroll` event of a wheel or a `scrollTo` runs in the rendering steps
//! before the frame that shows it.
//!
//! Then, if JS asked for `requestAnimationFrame` callbacks (`AnimationFrame`), they run, after the
//! scroll events as in the HTML steps. A request also schedules the steps for the next frame
//! (`Window::on_next_frame`), so a window that nothing else draws still runs them. What a callback
//! requests waits for the frame after, because the request is cleared before JS is called.
//!
//! The steps run once per frame, and only for a frame. A frame is a draw that answers the display
//! link (`Window::drawing_for_frame_request`) or, in the test renderer, one of its explicit frames
//! (`as_frame`); a draw a read, an automation call or an update makes in between runs none, and
//! asks for the next frame if its paint shows an offset nobody reported. When the steps ran in
//! `on_next_frame` and left the window dirty, the draw that follows in the same frame skips them
//! (`AnimationFrame::mark_stepped`), so a smooth scroll does not advance and report twice.
//!
//! The paint only registers a scroller and checks that it painted the offset it reported. An offset
//! that layout moved (a clamp, anchoring) asks for the next frame, whose steps report it.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{App, ScrollHandle, Window};

use crate::automation::AutomationClock;
use crate::events::sync_dispatch;
use crate::renderer::{EventCallback, SharedPaintReports};

/// Values closer than this are the same value. Layout is deterministic, so this only absorbs float
/// noise from fractional scale factors.
const EPSILON: f32 = 0.01;

type Offset = (f32, f32);

struct Watched {
    handle: ScrollHandle,
    reported: Offset,
    painted_at: u64,
    /// Where the offset was when the pass in progress began, before its layout clamped or anchored it.
    pass_start: Offset,
    /// While a layout-only pass has moved the handle (a forced read): the offset the pass began
    /// with, which is reported in place of the handle's, and the one it left. The event of what a
    /// layout does comes with the frame after the next paint, as in Chrome, unless a write
    /// since the pass has moved the handle on, which is reported as it stands. Cleared by a paint.
    laid_out: Option<(Offset, Offset)>,
}

impl Watched {
    fn to_report(&self) -> Offset {
        let offset = offset_of(&self.handle);
        match self.laid_out {
            Some((began, left)) if same(left, offset) => began,
            _ => offset,
        }
    }
}

fn offset_of(handle: &ScrollHandle) -> Offset {
    let offset = handle.offset();
    (f32::from(offset.x), f32::from(offset.y))
}

fn same(a: Offset, b: Offset) -> bool {
    (a.0 - b.0).abs() < EPSILON && (a.1 - b.1).abs() < EPSILON
}

/// The scrollers with an `onScroll` listener and the offset each last told it.
#[derive(Default)]
pub(crate) struct ScrollReports {
    watched: HashMap<u64, Watched>,
    painted: u64,
}

impl ScrollReports {
    /// Registers `id` as painted. Its first paint sets the baseline, which is not an event. True
    /// when the offset it painted is not the reported one, so a frame is needed to report it.
    pub(crate) fn note_painted(&mut self, id: u64, handle: &ScrollHandle) -> bool {
        self.painted += 1;
        let painted_at = self.painted;
        let offset = offset_of(handle);
        let watched = self.watched.entry(id).or_insert_with(|| Watched {
            handle: handle.clone(),
            reported: offset,
            painted_at,
            pass_start: offset,
            laid_out: None,
        });
        watched.handle = handle.clone();
        watched.painted_at = painted_at;
        watched.laid_out = None;
        !same(watched.reported, offset)
    }

    /// A pass is about to build: what the layout of it moves is the difference to this.
    pub(crate) fn begin_pass(&mut self) {
        for watched in self.watched.values_mut() {
            watched.pass_start = offset_of(&watched.handle);
        }
    }

    /// `id` was laid out by a pass that paints nothing. If that pass moved it, the offset it began
    /// with is the one the next frame's steps report.
    pub(crate) fn note_laid_out(&mut self, id: u64) {
        let Some(watched) = self.watched.get_mut(&id) else {
            return;
        };
        let left = offset_of(&watched.handle);
        if !same(watched.pass_start, left) {
            // A write between the two passes moved the handle off where the earlier one left it, and
            // what that pass moved is no longer what is reported.
            let began = match watched.laid_out {
                Some((began, earlier_left)) if same(earlier_left, watched.pass_start) => began,
                _ => watched.pass_start,
            };
            watched.laid_out = Some((began, left));
        }
    }

    /// Forgets the scrollers `keep` refuses: a dropped listener reports its offset again, like a
    /// new one, when it comes back.
    pub(crate) fn retain(&mut self, mut keep: impl FnMut(u64) -> bool) {
        if !self.watched.is_empty() {
            self.watched.retain(|id, _| keep(*id));
        }
    }

    /// The scrollers whose offset is not the reported one, in paint order.
    fn changed(&self) -> Vec<u64> {
        let mut changed: Vec<(u64, u64)> = self
            .watched
            .iter()
            .filter(|(_, watched)| !same(watched.reported, watched.to_report()))
            .map(|(id, watched)| (watched.painted_at, *id))
            .collect();
        changed.sort_unstable();
        changed.into_iter().map(|(_, id)| id).collect()
    }

    /// The offset of `id` if it is not the reported one, which it is from now on. A handler that ran
    /// for an earlier scroller may have moved this one back or removed it.
    fn take_change(&mut self, id: u64) -> Option<Offset> {
        let watched = self.watched.get_mut(&id)?;
        let offset = watched.to_report();
        if same(watched.reported, offset) {
            return None;
        }
        watched.reported = offset;
        Some(offset)
    }
}

/// Whether JS has `requestAnimationFrame` callbacks waiting for this window's next frame, and
/// whether this frame's steps have already run.
#[derive(Default)]
pub(crate) struct AnimationFrame {
    requested: bool,
    stepped: bool,
}

impl AnimationFrame {
    /// True when the request is new, so a frame has to be scheduled for it.
    pub(crate) fn request(&mut self) -> bool {
        !std::mem::replace(&mut self.requested, true)
    }

    fn take(&mut self) -> bool {
        std::mem::replace(&mut self.requested, false)
    }

    /// The steps ran ahead of a draw that is to follow in this frame, which must not run them again.
    fn mark_stepped(&mut self) {
        self.stepped = true;
    }

    /// True once after `mark_stepped`: the draw it was for.
    fn take_stepped(&mut self) -> bool {
        std::mem::take(&mut self.stepped)
    }
}

thread_local! {
    static EXPLICIT_FRAME: Cell<u32> = const { Cell::new(0) };
}

/// Runs `run`, in which the draws of the test renderer count as a frame: its `flush`, `drawFrame`
/// and the draw an input ends with stand for the display link, and no other draw it makes does.
pub(crate) fn as_frame<R>(run: impl FnOnce() -> R) -> R {
    struct Leave;
    impl Drop for Leave {
        fn drop(&mut self) {
            EXPLICIT_FRAME.with(|depth| depth.set(depth.get() - 1));
        }
    }
    EXPLICIT_FRAME.with(|depth| depth.set(depth.get() + 1));
    let _leave = Leave;
    run()
}

fn in_explicit_frame() -> bool {
    EXPLICIT_FRAME.with(|depth| depth.get() > 0)
}

/// The event type JS runs the callbacks for. It goes the way of any sync event, so it is a call
/// from native into JS made with the window stashed, which a callback that writes needs.
const ANIMATION_FRAME_EVENT: &str = "animationframe";

/// The steps of one window.
#[derive(Clone)]
pub(crate) struct FrameSteps {
    reports: SharedPaintReports,
    callback: Option<EventCallback>,
    clock: AutomationClock,
}

impl FrameSteps {
    pub(crate) fn new(reports: SharedPaintReports, callback: Option<EventCallback>, clock: AutomationClock) -> Self {
        Self { reports, callback, clock }
    }

    /// What `Window::set_frame_steps` runs before every draw.
    pub(crate) fn before_draw(self) -> Rc<dyn Fn(&mut Window, &mut App)> {
        Rc::new(move |window: &mut Window, cx: &mut App| {
            // A draw a handler's own call makes (a read that paints) leaves the steps to the next
            // one, since a handler cannot be called while another is on the stack.
            if sync_dispatch::in_sync_call() {
                return;
            }
            if !(window.drawing_for_frame_request() || in_explicit_frame()) {
                return;
            }
            if self.reports.borrow_mut().animation_frame.take_stepped() {
                return;
            }
            self.run(window, cx);
        })
    }

    /// The steps of the frame `Window::on_next_frame` delivers, ahead of its draw.
    fn next_frame(&self, window: &mut Window, cx: &mut App) {
        if sync_dispatch::in_sync_call() {
            // Inside a handler's own call the frame cannot be stepped, and it would be lost: the
            // request stays set, so nothing else would ask for another one.
            let steps = self.clone();
            window.on_next_frame(move |window, cx| steps.next_frame(window, cx));
            return;
        }
        self.run(window, cx);
        if window.has_pending_draw() {
            self.reports.borrow_mut().animation_frame.mark_stepped();
        }
    }

    fn run(&self, window: &mut Window, cx: &mut App) {
        let now = self.clock.now();
        crate::renderer::settle_scroll_writes();
        crate::scroll::advance_animations(now);
        self.report_scrolls(window, cx);
        self.run_animation_frame(now, window, cx);
    }

    fn report_scrolls(&self, window: &mut Window, cx: &mut App) {
        let changed = self.reports.borrow().scrolls.changed();
        for id in changed {
            let Some(offset) = self.reports.borrow_mut().scrolls.take_change(id) else {
                continue;
            };
            sync_dispatch::emit_full(window, cx, &self.callback, id, "scroll", |payload| {
                payload.scroll_x = Some(f64::from(offset.0));
                payload.scroll_y = Some(f64::from(offset.1));
            });
        }
    }

    fn run_animation_frame(&self, now: web_time::Instant, window: &mut Window, cx: &mut App) {
        if !self.reports.borrow_mut().animation_frame.take() {
            return;
        }
        let timeline_time = self.clock.ms_of(now);
        sync_dispatch::emit_full(window, cx, &self.callback, 0, ANIMATION_FRAME_EVENT, |payload| {
            payload.timeline_time = Some(timeline_time);
        });
    }

    /// Asks for the steps of the next frame to run the animation frame callbacks: the next frame
    /// is one even when nothing else asks for a draw.
    pub(crate) fn request_animation_frame(&self, window: &mut Window) {
        if self.reports.borrow_mut().animation_frame.request() {
            let steps = self.clone();
            window.on_next_frame(move |window, cx| steps.next_frame(window, cx));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, px};

    fn handle_at(y: f32) -> ScrollHandle {
        let handle = ScrollHandle::new();
        handle.set_offset(point(px(0.0), px(y)));
        handle
    }

    #[test]
    fn an_animation_frame_is_requested_once_until_it_runs() {
        let mut frame = AnimationFrame::default();
        assert!(frame.request(), "the first request schedules a frame");
        assert!(!frame.request(), "a second one waits for the same frame");
        assert!(frame.take());
        assert!(!frame.take());
        assert!(frame.request(), "a request made while the callbacks ran needs the next frame");
    }

    #[test]
    fn the_first_paint_is_the_baseline_and_a_moved_handle_is_reported_once() {
        let mut reports = ScrollReports::default();
        let handle = handle_at(0.0);
        assert!(!reports.note_painted(1, &handle), "the first paint reports nothing");
        assert!(reports.changed().is_empty());

        handle.set_offset(point(px(0.0), px(-40.0)));
        assert_eq!(reports.changed(), vec![1]);
        assert_eq!(reports.take_change(1), Some((0.0, -40.0)));
        assert_eq!(reports.take_change(1), None, "the offset is reported");
        assert!(!reports.note_painted(1, &handle), "a paint of the reported offset needs no frame");
    }

    #[test]
    fn a_paint_of_an_offset_the_steps_did_not_report_asks_for_a_frame() {
        let mut reports = ScrollReports::default();
        let handle = handle_at(0.0);
        reports.note_painted(1, &handle);
        handle.set_offset(point(px(0.0), px(-5.0)));
        assert!(reports.note_painted(1, &handle));
    }

    #[test]
    fn scrollers_are_reported_in_paint_order() {
        let mut reports = ScrollReports::default();
        let (first, second) = (handle_at(0.0), handle_at(0.0));
        reports.note_painted(7, &first);
        reports.note_painted(3, &second);
        first.set_offset(point(px(0.0), px(-1.0)));
        second.set_offset(point(px(0.0), px(-1.0)));
        assert_eq!(reports.changed(), vec![7, 3]);
    }

    #[test]
    fn what_a_layout_only_pass_moved_waits_for_a_paint() {
        let mut reports = ScrollReports::default();
        let handle = handle_at(-100.0);
        reports.note_painted(1, &handle);

        reports.begin_pass();
        handle.set_offset(point(px(0.0), px(-150.0)));
        reports.note_laid_out(1);
        assert!(reports.changed().is_empty(), "the steps report the offset the pass began with");

        assert!(reports.note_painted(1, &handle), "the paint shows an offset nobody reported");
        assert_eq!(reports.take_change(1), Some((0.0, -150.0)));
    }

    #[test]
    fn a_write_after_a_layout_only_pass_is_reported_as_it_stands() {
        let mut reports = ScrollReports::default();
        let handle = handle_at(-100.0);
        reports.note_painted(1, &handle);

        reports.begin_pass();
        handle.set_offset(point(px(0.0), px(-150.0)));
        reports.note_laid_out(1);
        handle.set_offset(point(px(0.0), px(-300.0)));
        assert_eq!(reports.take_change(1), Some((0.0, -300.0)));
    }

    #[test]
    fn steps_that_ran_ahead_of_a_draw_are_skipped_by_that_draw_once() {
        let mut frame = AnimationFrame::default();
        assert!(!frame.take_stepped(), "nothing ran ahead of a frame by default");
        frame.mark_stepped();
        assert!(frame.take_stepped(), "the draw of the same frame skips its steps");
        assert!(!frame.take_stepped(), "the draw of the next frame runs them");
    }

    #[test]
    fn a_draw_is_a_frame_for_the_steps_only_inside_as_frame() {
        assert!(!in_explicit_frame());
        as_frame(|| {
            assert!(in_explicit_frame());
            as_frame(|| assert!(in_explicit_frame()));
            assert!(in_explicit_frame(), "leaving a nested frame does not end the outer one");
        });
        assert!(!in_explicit_frame());
    }

    #[test]
    fn a_frame_that_unwinds_is_not_left_open() {
        let unwound = std::panic::catch_unwind(|| as_frame(|| panic!("a draw failed")));
        assert!(unwound.is_err());
        assert!(!in_explicit_frame());
    }

    #[test]
    fn two_layout_only_passes_with_no_write_between_report_what_the_first_began_with() {
        let mut reports = ScrollReports::default();
        let handle = handle_at(-100.0);
        reports.note_painted(1, &handle);

        reports.begin_pass();
        handle.set_offset(point(px(0.0), px(-150.0)));
        reports.note_laid_out(1);
        reports.begin_pass();
        handle.set_offset(point(px(0.0), px(-200.0)));
        reports.note_laid_out(1);

        assert!(reports.changed().is_empty(), "the offset before either pass is still the reported one");
        assert!(reports.note_painted(1, &handle));
        assert_eq!(reports.take_change(1), Some((0.0, -200.0)));
    }

    #[test]
    fn a_write_between_two_layout_only_passes_is_not_hidden_by_the_second() {
        let mut reports = ScrollReports::default();
        let handle = handle_at(-100.0);
        reports.note_painted(1, &handle);

        reports.begin_pass();
        handle.set_offset(point(px(0.0), px(-150.0)));
        reports.note_laid_out(1);
        // A write moves the handle on, and the second pass moves it again.
        handle.set_offset(point(px(0.0), px(-300.0)));
        reports.begin_pass();
        handle.set_offset(point(px(0.0), px(-350.0)));
        reports.note_laid_out(1);

        assert_eq!(
            reports.changed(),
            vec![1],
            "the write is a change: the handle began the second pass at -300, not at the reported -100"
        );
        assert_eq!(reports.take_change(1), Some((0.0, -300.0)));
    }
}
