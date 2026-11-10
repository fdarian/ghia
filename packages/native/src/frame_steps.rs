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
//! The paint only registers a scroller and checks that it painted the offset it reported. An offset
//! that layout moved (a clamp, anchoring) asks for the next frame, whose steps report it.

use std::collections::HashMap;
use std::rc::Rc;

use gpui::{App, ScrollHandle, Window};

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
            let began = watched.laid_out.map_or(watched.pass_start, |(began, _)| began);
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

/// Whether JS has `requestAnimationFrame` callbacks waiting for this window's next frame.
#[derive(Default)]
pub(crate) struct AnimationFrame {
    requested: bool,
}

impl AnimationFrame {
    /// True when the request is new, so a frame has to be scheduled for it.
    pub(crate) fn request(&mut self) -> bool {
        !std::mem::replace(&mut self.requested, true)
    }

    fn take(&mut self) -> bool {
        std::mem::replace(&mut self.requested, false)
    }
}

/// The event type JS runs the callbacks for. It goes the way of any sync event, so it is a call
/// from native into JS made with the window stashed, which a callback that writes needs.
const ANIMATION_FRAME_EVENT: &str = "animationframe";

/// The steps a window runs before each draw. `now` is the clock the view's frames sample.
pub(crate) fn steps(
    reports: SharedPaintReports,
    callback: Option<EventCallback>,
    now: impl Fn() -> web_time::Instant + 'static,
) -> Rc<dyn Fn(&mut Window, &mut App)> {
    Rc::new(move |window: &mut Window, cx: &mut App| {
        // A draw a handler's own call makes (a read that paints) leaves the steps to the next one,
        // since a handler cannot be called while another is on the stack.
        if sync_dispatch::in_sync_call() {
            return;
        }
        crate::renderer::settle_scroll_writes();
        crate::scroll::advance_animations(now());
        report_scrolls(&reports, &callback, window, cx);
        run_animation_frame(&reports, &callback, window, cx);
    })
}

fn report_scrolls(
    reports: &SharedPaintReports,
    callback: &Option<EventCallback>,
    window: &mut Window,
    cx: &mut App,
) {
    let changed = reports.borrow().scrolls.changed();
    for id in changed {
        let Some(offset) = reports.borrow_mut().scrolls.take_change(id) else {
            continue;
        };
        sync_dispatch::emit_full(window, cx, callback, id, "scroll", |payload| {
            payload.scroll_x = Some(f64::from(offset.0));
            payload.scroll_y = Some(f64::from(offset.1));
        });
    }
}

fn run_animation_frame(
    reports: &SharedPaintReports,
    callback: &Option<EventCallback>,
    window: &mut Window,
    cx: &mut App,
) {
    if !reports.borrow_mut().animation_frame.take() {
        return;
    }
    sync_dispatch::emit_full(window, cx, callback, 0, ANIMATION_FRAME_EVENT, |_| {});
}

/// Asks for the steps of the next frame to run the animation frame callbacks: the next frame
/// is one even when nothing else asks for a draw.
pub(crate) fn request_animation_frame(
    reports: &SharedPaintReports,
    steps: Rc<dyn Fn(&mut Window, &mut App)>,
    window: &mut Window,
) {
    if reports.borrow_mut().animation_frame.request() {
        window.on_next_frame(move |window, cx| steps(window, cx));
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
}
