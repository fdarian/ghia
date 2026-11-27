//! The windows open on this thread's GPUI App (macOS).
//!
//! The first renderer's `init` creates the App, and every renderer after it opens another window
//! on it. GPUI closes a window when the user does (the traffic light, `⌘W`), when the renderer
//! asks (`closeWindow`) and when the App quits; each of those ends in `App::on_window_closed`,
//! which `observe_closes` forwards here. A renderer reads its own window's state from here
//! (`isWindowClosed`) because the App goes on running for the windows that are left.
//!
//! A window that closed takes the state that is keyed by it: the per-window maps of host element
//! ids (`window_map`) and the sync handler route.

use std::cell::{Cell, RefCell};

use gpui::WindowId;
use rustc_hash::FxHashSet;

thread_local! {
    static OPEN: RefCell<FxHashSet<WindowId>> = RefCell::new(FxHashSet::default());
    /// The platform quit: every window is gone or going, and `tick()` reports it.
    static ENDED: Cell<bool> = const { Cell::new(false) };
}

pub(crate) fn opened(window: WindowId) {
    OPEN.with(|open| open.borrow_mut().insert(window));
}

pub(crate) fn is_open(window: WindowId) -> bool {
    OPEN.with(|open| open.borrow().contains(&window))
}

#[cfg(test)]
fn open_count() -> usize {
    OPEN.with(|open| open.borrow().len())
}

/// Records that the platform quit, which `tick()` saw.
pub(crate) fn note_app_ended() {
    ENDED.set(true);
}

pub(crate) fn app_has_ended() -> bool {
    ENDED.get()
}

/// Makes `app` tell this module when a window closes. Once per App.
pub(crate) fn observe_closes(cx: &mut gpui::App) {
    cx.on_window_closed(|_cx, window| closed(window)).detach();
}

/// A window closed: it is no longer open, and nothing is kept for it.
pub(crate) fn closed(window: WindowId) {
    OPEN.with(|open| open.borrow_mut().remove(&window));
    crate::renderer::forget_scroll_state(window);
    crate::scroll::forget_window(window);
    crate::scroll_write::forget_window(window);
    crate::scrollbar::forget_window(window);
    crate::layout::anchor_size::forget_window(window);
    crate::automation::drop_window(window);
    crate::events::sync_dispatch::unbind_window(window);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_is_open_from_opened_until_closed_and_the_others_are_not_touched() {
        let (first, second) = (WindowId::from(101), WindowId::from(102));
        opened(first);
        opened(second);
        assert!(is_open(first) && is_open(second));
        closed(second);
        assert!(is_open(first) && !is_open(second));
        closed(second);
        assert_eq!(open_count(), 1);
        closed(first);
        assert_eq!(open_count(), 0);
    }
}
