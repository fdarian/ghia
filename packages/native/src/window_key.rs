//! Whether the window is the key window: the AppKit answer, which `focus_emulation` and
//! `setWindowActive` do not change. And whether AppKit counts it visible (not occluded), which
//! decides whether its display link can start.

use napi::{Error, Result};
use objc::runtime::{Object, YES};
use objc::{msg_send, sel, sel_impl};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

fn ns_view_of(window: &gpui::Window) -> Result<*mut Object> {
    let handle = HasWindowHandle::window_handle(window)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    match handle.as_raw() {
        RawWindowHandle::AppKit(appkit) => Ok(appkit.ns_view.as_ptr() as *mut Object),
        other => Err(Error::from_reason(format!(
            "The window is not an AppKit window: {other:?}"
        ))),
    }
}

/// `NSWindowOcclusionStateVisible`.
const OCCLUSION_STATE_VISIBLE: usize = 1 << 1;

pub(crate) fn is_visible(window: &gpui::Window) -> Result<bool> {
    let ns_view = ns_view_of(window)?;
    // SAFETY: as in `is_key`.
    unsafe {
        let ns_window: *mut Object = msg_send![ns_view, window];
        if ns_window.is_null() {
            return Ok(false);
        }
        let state: usize = msg_send![ns_window, occlusionState];
        Ok(state & OCCLUSION_STATE_VISIBLE != 0)
    }
}

pub(crate) fn is_key(window: &gpui::Window) -> Result<bool> {
    let ns_view = ns_view_of(window)?;
    // SAFETY: the view is the live content view of this renderer's window, and napi calls run
    // on the main thread.
    unsafe {
        let ns_window: *mut Object = msg_send![ns_view, window];
        if ns_window.is_null() {
            return Ok(false);
        }
        let key: objc::runtime::BOOL = msg_send![ns_window, isKeyWindow];
        Ok(key == YES)
    }
}
