//! Tells JS when its window becomes or stops being the active one, so `window` hears `focus` and
//! `blur` as the DOM does.
//!
//! The elements' `focus` and `blur` follow the same GPUI activity (`focus.rs` reads
//! `Window::is_window_active`), but they are events of an element. This one is the window's own,
//! and it is produced only while JS listens for `focus` or `blur` on `window` or `document`, so
//! the platform's activation changes cost nothing for an app that does not ask.

use crate::renderer::{emit_event_full, GpuixView};

/// The event type JS routes to the window of the renderer: `value` is `"true"` or `"false"`.
const WINDOW_ACTIVE_EVENT: &str = "windowActive";

impl GpuixView {
    pub(crate) fn observe_window_activity(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) {
        self.activity_subscription = Some(cx.observe_window_activation(window, |view, window, _cx| {
            let listened = {
                let pointer = view.pointer.borrow();
                pointer.window_listens("focus") || pointer.window_listens("blur")
            };
            if !listened {
                return;
            }
            let active = window.is_window_active();
            emit_event_full(&view.event_callback, 0, WINDOW_ACTIVE_EVENT, |payload| {
                payload.value = Some(active.to_string());
            });
        }));
    }
}
