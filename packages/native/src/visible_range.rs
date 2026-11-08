//! The `visibleRange` event of a virtual list, from every way its scroll position changes.
//!
//! gpui calls a list's scroll handler for a wheel only, so the handler alone would leave an app
//! that windows its rows from `onVisibleRange` stuck at the first window under `scrollTo`,
//! `scrollTop = n` and the keyboard. The handler and the writes of `scroll_write` report through
//! [`RangeReporter::report`], so a range is reported once however the list came to it. The range
//! of a write is the one a wheel to the same offset reports (`ListState::visible_range_at`).
//! A `scrollToItem` is the exception: it is applied by the next render and reports from the paint that
//! follows, because the layout is what holds its offset to the end of the list.

use std::cell::{Cell, RefCell};
use std::ops::Range;

use crate::renderer::{emit_event_full, EventCallback};

pub(crate) struct RangeReporter {
    list_id: u64,
    /// The range last reported. Held here, not in the scroll handler, because the handler is set
    /// again every render.
    reported: Cell<Option<(usize, usize)>>,
    /// The page's callback while the list has an `onVisibleRange` handler, `None` otherwise.
    listener: RefCell<Option<EventCallback>>,
    /// A `scrollToItem` was applied and the paint that lays it out has not reported its rows.
    awaiting_layout: Cell<bool>,
}

impl RangeReporter {
    pub(crate) fn new(list_id: u64) -> Self {
        Self {
            list_id,
            reported: Cell::new(None),
            listener: RefCell::new(None),
            awaiting_layout: Cell::new(false),
        }
    }

    pub(crate) fn list_id(&self) -> u64 {
        self.list_id
    }

    pub(crate) fn listen(&self, callback: &Option<EventCallback>, listens: bool) {
        *self.listener.borrow_mut() = callback.clone().filter(|_| listens);
    }

    pub(crate) fn listens(&self) -> bool {
        self.listener.borrow().is_some()
    }

    /// Reports `range` unless it is the one last reported. The event reaches the page later, as
    /// every event does, so a handler never runs inside the write that moved the list.
    pub(crate) fn report(&self, range: Range<usize>) {
        let listener = self.listener.borrow().clone();
        if listener.is_none() {
            return;
        }
        let range = (range.start, range.end);
        if self.reported.replace(Some(range)) == Some(range) {
            return;
        }
        emit_event_full(&listener, self.list_id, "visibleRange", |payload| {
            payload.start_index = Some(range.0 as f64);
            payload.end_index = Some(range.1 as f64);
        });
    }

    /// Reports the rows a scroll of `state` to `offset` shows. A list that has not been laid out
    /// has no range to report: its first layout is not a scroll.
    pub(crate) fn report_at(&self, state: &gpui::ListState, offset: gpui::ListOffset) {
        if !self.listens() {
            return;
        }
        if let Some(range) = state.visible_range_at(offset) {
            self.report(range);
        }
    }

    /// Marks that a queued `scrollToItem` was applied to the list and its range is not known yet.
    /// The offset it asked for is held to the extent the layout finds, which rows still to be
    /// measured change, so the range waits for the paint that follows ([`Self::report_laid_out`]).
    pub(crate) fn await_layout(&self) {
        self.awaiting_layout.set(self.listens());
    }

    /// Reports the rows a laid-out list shows if a `scrollToItem` is waiting for them: the list
    /// has held the offset to what it can scroll to by now, as the layout does for `scrollTop`,
    /// so `scrollToItem(last)` shows the last viewport's worth of rows. Called from paint.
    pub(crate) fn report_laid_out(&self, state: &gpui::ListState) {
        if !self.awaiting_layout.replace(false) {
            return;
        }
        let top = state.logical_scroll_top();
        if top.item_ix < state.item_count() {
            self.report_at(state, top);
        } else {
            self.report(rows_shown_at_end(state));
        }
    }
}

/// The rows of a bottom-aligned list resting at its end, which has no row for an anchor
/// (`logical_scroll_top` is the item count) and so no offset to read the range at: the last rows,
/// as many as the height of the list takes. Their heights are the ones the layout measured; their
/// positions are not read, because `bounds_for_item` places the rows against the anchor, which at
/// the end is the end of all the rows and not where the list rests. A row without a box was not
/// measured, so it is not one of the rows that show.
fn rows_shown_at_end(state: &gpui::ListState) -> Range<usize> {
    let count = state.item_count();
    let height = state.viewport_bounds().size.height;
    let mut first = count;
    let mut covered = gpui::px(0.0);
    while first > 0 && covered < height {
        let Some(row) = state.bounds_for_item(first - 1) else {
            break;
        };
        covered += row.size.height;
        first -= 1;
    }
    first..count
}
