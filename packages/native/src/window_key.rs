//! Whether the window is the key window: the AppKit answer, which `focus_emulation` and
//! `setWindowActive` do not change.

use napi::{Error, Result};
use objc::runtime::{Object, YES};
use objc::{msg_send, sel, sel_impl};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

pub(crate) fn is_key(window: &gpui::Window) -> Result<bool> {
    let handle = HasWindowHandle::window_handle(window)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    let ns_view = match handle.as_raw() {
        RawWindowHandle::AppKit(appkit) => appkit.ns_view.as_ptr() as *mut Object,
        other => {
            return Err(Error::from_reason(format!(
                "The window is not an AppKit window: {other:?}"
            )))
        }
    };
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
