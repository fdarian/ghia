//! The `visibleRange` event of a virtual list, from every way its scroll position changes.
//!
//! gpui calls a list's scroll handler for a wheel only, so the handler alone would leave an app
//! that windows its rows from `onVisibleRange` stuck at the first window under `scrollTo`,
//! `scrollTop = n` and the keyboard. The handler and the writes of `scroll_write` report through
//! [`RangeReporter::report`], so a range is reported once however the list came to it. The range
//! of a write is the one a wheel to the same offset reports (`ListState::visible_range_at`).

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
}

impl RangeReporter {
    pub(crate) fn new(list_id: u64) -> Self {
        Self {
            list_id,
            reported: Cell::new(None),
            listener: RefCell::new(None),
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
}
