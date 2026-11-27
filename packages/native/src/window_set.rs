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
#[cfg(target_os = "macos")]
use napi::{Error, Result};
use rustc_hash::FxHashSet;

#[cfg(target_os = "macos")]
use crate::renderer::GpuixView;

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

/// Records that the platform quit, which `tick()` saw. GPUI's shutdown drops every window without telling
/// `on_window_closed`, so the windows still listed here are the ones it took.
pub(crate) fn note_app_ended() {
    ENDED.set(true);
    let open: Vec<WindowId> = OPEN.with(|open| open.borrow().iter().copied().collect());
    for window in open {
        closed(window);
    }
}

pub(crate) fn app_has_ended() -> bool {
    ENDED.get()
}

/// GPUI answers an update of a window it no longer has with this message (`context("window not found")`).
#[cfg(target_os = "macos")]
const WINDOW_NOT_FOUND: &str = "window not found";

/// The error of an update of `window`. The window being gone is learned here when nothing else told
/// this module (a quit that dropped it, a close in the middle of a call), so `isWindowClosed()` reads
/// it from then on.
#[cfg(target_os = "macos")]
fn update_error(window: WindowId, message: String) -> Error {
    if message == WINDOW_NOT_FOUND {
        closed(window);
    }
    Error::from_reason(message)
}

/// `update_window_in` for a change that returns nothing. When it is called while the
/// root view is already being updated, it runs once that update has returned.
#[cfg(target_os = "macos")]
pub(crate) fn update_window_or_defer_in(
    handle: gpui::WindowHandle<GpuixView>,
    update: impl FnOnce(&mut GpuixView, &mut gpui::Window, &mut gpui::Context<GpuixView>) + 'static,
) -> Result<()> {
    crate::events::sync_dispatch::route(
        update,
        |update| crate::events::sync_dispatch::update_view_of_or_defer(handle, update),
        |message| update_error(handle.window_id(), message),
        |update| update_window_outside(handle, update),
    )
}

/// Updates the root view of `handle`, the window of one renderer. Inside a sync call that is the
/// window being dispatched, unless a handler of another window called this renderer.
#[cfg(target_os = "macos")]
pub(crate) fn update_window_in<R>(
    handle: gpui::WindowHandle<GpuixView>,
    update: impl FnOnce(&mut GpuixView, &mut gpui::Window, &mut gpui::Context<GpuixView>) -> R,
) -> Result<R> {
    crate::events::sync_dispatch::native_call(|| {
        crate::events::sync_dispatch::route(
            update,
            |update| crate::events::sync_dispatch::update_view_of(handle, update),
            |message| update_error(handle.window_id(), message),
            |update| update_window_outside(handle, update),
        )
    })
}

#[cfg(target_os = "macos")]
fn update_window_outside<R>(
    handle: gpui::WindowHandle<GpuixView>,
    update: impl FnOnce(&mut GpuixView, &mut gpui::Window, &mut gpui::Context<GpuixView>) -> R,
) -> Result<R> {
    crate::renderer::GPUI_APP.with(|app| {
        let app = app.borrow();
        let app = app
            .as_ref()
            .ok_or_else(|| Error::from_reason("GPUI application is not initialized"))?;
        app.update(|cx| {
            handle
                .update(cx, update)
                .map_err(|error| update_error(handle.window_id(), error.to_string()))
        })
    })
}

/// A sync input handler can reach the view through its own renderer calls, so the work that
/// only needs the window runs without leasing the root view.
#[cfg(target_os = "macos")]
pub(crate) fn update_window_without_view_in<R>(
    handle: gpui::WindowHandle<GpuixView>,
    update: impl FnOnce(&mut gpui::Window, &mut gpui::App) -> R,
) -> Result<R> {
    crate::events::sync_dispatch::native_call(|| {
        crate::events::sync_dispatch::route(
            update,
            |update| crate::events::sync_dispatch::update_window_of(handle, update),
            |message| update_error(handle.window_id(), message),
            |update| {
                crate::renderer::GPUI_APP.with(|app| {
                    let app = app.borrow();
                    let app = app.as_ref().ok_or_else(|| {
                        Error::from_reason("GPUI application is not initialized")
                    })?;
                    app.update(|cx| {
                        gpui::AnyWindowHandle::from(handle)
                            .update(cx, move |_view, window, cx| update(window, cx))
                            .map_err(|error| update_error(handle.window_id(), error.to_string()))
                    })
                })
            },
        )
    })
}

/// Opens the window of a renderer that is not the first, on the App the first one made: from the dispatch of an event (a
/// `window.open` of a handler) on the App that dispatch holds, otherwise on the thread's.
#[cfg(target_os = "macos")]
pub(crate) fn open_another(
    request: &crate::renderer::WindowRequest,
    appearance: Option<gpui::WindowAppearance>,
    activate: bool,
) -> Result<gpui::WindowHandle<GpuixView>> {
    let open = |cx: &mut gpui::App| {
        // The appearance override is the App's, not a window's: a window that names
        // none leaves the one the first window set.
        if appearance.is_some() {
            cx.set_window_appearance(appearance);
        }
        let window_handle = crate::renderer::open_gpuix_window(cx, request).map_err(|error| {
            Error::from_reason(format!("Failed to open the GPUI window: {error}"))
        })?;
        if activate {
            cx.activate(true);
        }
        Ok::<_, Error>(window_handle)
    };
    if crate::events::sync_dispatch::in_sync_call() {
        // `window.open` from an event handler: GPUI has the App borrowed for the input,
        // so the window opens on the one the dispatch holds, as a handler of Zed's does.
        crate::events::sync_dispatch::with_active_window(|_window, cx| open(cx)).ok_or_else(|| {
            Error::from_reason(
                "A window cannot be opened from inside a native call that holds no window: open it from an event handler or outside the frame",
            )
        })?
    } else {
        crate::renderer::GPUI_APP.with(|app| {
            let app = app.borrow();
            let app = app.as_ref().expect("an App exists: the caller checked it");
            app.update(open)
        })
    }
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
    crate::renderer::forget_pending_layout(window);
    crate::text::paint::forget_window(window);
    crate::text::inline_hit::forget_window(window);
    crate::text::search::forget_window(window);
    crate::text::inline_focus::forget_window(window);
    crate::editing::caret::forget_window(window);
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

    /// GPUI's shutdown drops the windows without `on_window_closed`, so the quit is what closes them here.
    #[test]
    fn the_app_ending_closes_every_window_it_took() {
        let (first, second) = (WindowId::from(111), WindowId::from(112));
        opened(first);
        opened(second);
        assert!(!app_has_ended());
        note_app_ended();
        assert!(app_has_ended() && !is_open(first) && !is_open(second));
        assert_eq!(open_count(), 0);
    }

    /// Test windows repeat ids across suites, so an entry a closed window left would be a later window's.
    #[gpui::test]
    fn a_closed_window_leaves_no_text_paint_or_caret_state_behind(cx: &mut gpui::TestAppContext) {
        let (gone, kept) = (WindowId::from(201), WindowId::from(202));
        let handle = cx.update(|cx| cx.focus_handle());
        for window in [gone, kept] {
            opened(window);
            crate::text::paint::log_painted_text(window, "text".into());
            crate::text::inline_hit::frame_reset(window);
            crate::text::search::ordinal_frame_reset(window);
            crate::editing::caret::hold_for_test(window);
            crate::text::inline_focus::hold_press_focus_for_test(window, handle.clone());
        }
        closed(gone);
        assert!(!crate::text::paint::holds_frame(gone));
        assert!(!crate::text::inline_hit::holds_paragraphs(gone));
        assert!(!crate::text::search::holds_ordinals(gone));
        assert!(!crate::editing::caret::holds_caret_state(gone));
        assert!(!crate::text::inline_focus::holds_press_focus(gone));
        assert!(!crate::renderer::holds_pending_layout(gone));
        assert!(crate::text::paint::holds_frame(kept), "the window that is left keeps its own");
        assert!(crate::text::inline_hit::holds_paragraphs(kept));
        assert!(crate::text::search::holds_ordinals(kept));
        assert!(crate::editing::caret::holds_caret_state(kept));
        assert!(crate::text::inline_focus::holds_press_focus(kept));
        closed(kept);
    }
}
