//! The windows open on this thread's GPUI App (macOS).
//!
//! The first renderer's `init` creates the App, and every renderer after it opens another window
//! on it. GPUI closes a window when the user does (the traffic light, `⌘W`), when the renderer
//! asks (`closeWindow`) and when the App quits; each of those ends in `App::on_window_closed`,
//! which `observe_closes` forwards here. A renderer reads its own window's state from here
//! (`isWindowClosed`) because the App goes on running for the windows that are left.
//!
//! A window that closed takes the state that is keyed by it: the per-window maps of host element
//! ids (`window_map`). Its sync handler route goes too, once GPUI has dropped the window.

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
        forget(window);
    }
}

pub(crate) fn app_has_ended() -> bool {
    ENDED.get()
}

/// GPUI answers an update of a window it cannot lend with this message (`context("window not found")`). It
/// says the same for a window that is gone and for one that is in the middle of its own update: GPUI takes a
/// window out of its slot while it updates it (`App::update_window_id`), so a handler that runs inside that
/// update and reaches the window again (a focus listener of window B reading window A, whose click focused B)
/// gets it too. The message alone does not say which.
#[cfg(target_os = "macos")]
const WINDOW_NOT_FOUND: &str = "window not found";

/// What a call that reaches a window which is in the middle of its own update is told.
#[cfg(target_os = "macos")]
pub(crate) const WINDOW_BUSY: &str = "The window is being updated by an input that is being dispatched, so a handler of another window cannot reach it from here. Do the call from the window's own handler, or after the input.";

/// Whether GPUI still lists `window`. A window that is in the middle of its own update is out of its slot but its
/// id stays in `App::windows()`, which is what tells it from one that is gone.
#[cfg(target_os = "macos")]
pub(crate) fn is_listed(cx: &gpui::App, window: WindowId) -> bool {
    cx.windows().iter().any(|handle| handle.window_id() == window)
}

/// The error of an update of `window` that GPUI answered with `message`, knowing from `cx` whether the window is
/// still listed. A window that is gone is learned here when nothing else told this module (a quit that dropped it,
/// a close in the middle of a call), so `isWindowClosed()` reads it from then on; one that is only busy is open
/// and stays so.
#[cfg(target_os = "macos")]
pub(crate) fn update_error_in(cx: &gpui::App, window: WindowId, message: String) -> Error {
    if message != WINDOW_NOT_FOUND {
        return Error::from_reason(message);
    }
    if is_listed(cx, window) {
        return Error::from_reason(WINDOW_BUSY);
    }
    forget(window);
    Error::from_reason(message)
}

/// [`update_error_in`] for an update that ran through the app a sync dispatch holds, which this asks for the window
/// list. Without that app nothing says whether the window is gone, so it is not marked.
#[cfg(target_os = "macos")]
pub(crate) fn update_error(window: WindowId, message: String) -> Error {
    match crate::events::sync_dispatch::with_active_window(|_window, cx| update_error_in(cx, window, message.clone())) {
        Some(error) => error,
        None => Error::from_reason(message),
    }
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
                .map_err(|error| update_error_in(cx, handle.window_id(), error.to_string()))
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
                            .map_err(|error| update_error_in(cx, handle.window_id(), error.to_string()))
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
    cx.on_window_closed(|cx, window| {
        closed(window);
        // GPUI runs this observer before it drops the window, and the drop of the window's views
        // tells JS (`detach`) through the sync handler this binding routes to. The deferred effect
        // runs after the drop, so the views end synchronously: a queued event could be lost to
        // a process that exits right after the close.
        cx.defer(move |_| crate::events::sync_dispatch::unbind_window(window));
    })
    .detach();
}

/// A window closed: it is no longer open and its per-window state goes. It keeps its sync handler binding, which the
/// caller removes: `observe_closes` does so after GPUI has dropped the window, `forget` at once.
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
}

/// Closes a window GPUI already dropped, so nothing of it is left to drop and its sync handler binding goes at once.
pub(crate) fn forget(window: WindowId) {
    closed(window);
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

    /// GPUI answers "window not found" for a window in the middle of its own update as it does for a gone one,
    /// and only the window list tells them apart: the id stays listed while the window is out of its slot.
    #[cfg(target_os = "macos")]
    #[gpui::test]
    fn a_window_in_the_middle_of_its_own_update_is_listed_and_a_removed_one_is_not(cx: &mut gpui::TestAppContext) {
        use gpui::AppContext as _;
        let window = cx.add_window(|_, _| gpui::Empty);
        let id = window.window_id();
        let handle: gpui::AnyWindowHandle = window.into();
        let mut seen = None;
        cx.update_window(handle, |_, _, cx| {
            // The window is out of its slot here: GPUI cannot lend it again.
            let again = gpui::AnyWindowHandle::from(window).update(cx, |_, _, _| ());
            seen = Some((again.map_err(|error| error.to_string()), is_listed(cx, id)));
        })
        .unwrap();
        let (again, listed) = seen.unwrap();
        assert_eq!(again, Err(WINDOW_NOT_FOUND.to_string()));
        assert!(listed);
        let error = cx.update(|cx| update_error_in(cx, id, WINDOW_NOT_FOUND.to_string()));
        assert_eq!(error.reason, WINDOW_BUSY);

        cx.update_window(handle, |_, window, _| window.remove_window()).unwrap();
        cx.run_until_parked();
        assert!(!cx.update(|cx| is_listed(cx, id)));
        opened(id);
        let error = cx.update(|cx| update_error_in(cx, id, WINDOW_NOT_FOUND.to_string()));
        assert_eq!(error.reason, WINDOW_NOT_FOUND);
        assert!(!is_open(id), "a window GPUI no longer lists is closed");
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

    /// A view that drops with its window tells JS through the sync handler bound to that window, so the
    /// binding has to outlive GPUI's drop of the window and then go, with the window, once that is done.
    #[gpui::test]
    fn a_window_stays_bound_while_its_views_drop_and_is_unbound_after(cx: &mut gpui::TestAppContext) {
        use gpui::AppContext as _;
        use std::cell::Cell;
        use std::rc::Rc;

        struct Probe {
            window: WindowId,
            bound_on_drop: Rc<Cell<Option<bool>>>,
        }
        impl gpui::Render for Probe {
            fn render(&mut self, _: &mut gpui::Window, _: &mut gpui::Context<Self>) -> impl gpui::IntoElement {
                gpui::Empty
            }
        }
        impl Drop for Probe {
            fn drop(&mut self) {
                self.bound_on_drop.set(Some(crate::events::sync_dispatch::is_window_bound(self.window)));
            }
        }

        let owner = crate::events::sync_dispatch::SyncHandlerOwner::new();
        let bound_on_drop = Rc::new(Cell::new(None));
        let probe = bound_on_drop.clone();
        let window = cx.add_window(move |window, _| Probe { window: window.window_handle().window_id(), bound_on_drop: probe });
        let id = window.window_id();
        owner.bind_window(id);
        opened(id);
        cx.update(observe_closes);
        assert!(crate::events::sync_dispatch::is_window_bound(id));

        cx.update_window(window.into(), |_, window, _| window.remove_window()).unwrap();
        cx.run_until_parked();

        assert_eq!(bound_on_drop.get(), Some(true), "the view dropped while its window was still bound");
        assert!(!crate::events::sync_dispatch::is_window_bound(id), "a closed window is not left bound");
        assert!(!is_open(id));
    }
}
