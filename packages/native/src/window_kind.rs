//! The `kind` window option: which kind of platform window the options open.

use crate::renderer::WindowOptions;

/// `Err` carries the message the caller throws; it is checked when a renderer is created, before
/// any window exists.
pub(crate) fn window_kind(options: &WindowOptions) -> Result<gpui::WindowKind, String> {
    match options.kind.as_deref() {
        None | Some("normal") => Ok(gpui::WindowKind::Normal),
        Some("panel") => Ok(gpui::WindowKind::Panel),
        Some(other) => Err(format!(
            "Invalid window kind {other:?}: expected \"normal\" or \"panel\""
        )),
    }
}

/// A panel is non-activating, so opening it must not activate the application either: the window
/// flag decides key status inside the app, activation is what takes the keyboard from the
/// frontmost app. Other platforms open it as a normal window, which does activate.
pub(crate) fn activates_application(kind: &gpui::WindowKind, focus: bool) -> bool {
    focus && !(cfg!(target_os = "macos") && *kind == gpui::WindowKind::Panel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_kind(kind: Option<&str>) -> WindowOptions {
        WindowOptions {
            kind: kind.map(str::to_string),
            ..WindowOptions::default()
        }
    }

    #[test]
    fn no_kind_and_normal_are_a_normal_window() {
        assert_eq!(window_kind(&with_kind(None)), Ok(gpui::WindowKind::Normal));
        assert_eq!(
            window_kind(&with_kind(Some("normal"))),
            Ok(gpui::WindowKind::Normal)
        );
    }

    #[test]
    fn panel_is_a_panel_window() {
        assert_eq!(
            window_kind(&with_kind(Some("panel"))),
            Ok(gpui::WindowKind::Panel)
        );
    }

    #[test]
    fn an_unknown_kind_is_an_error_naming_the_value_and_the_choices() {
        for value in ["Panel", "popup", "dialog", ""] {
            let message = window_kind(&with_kind(Some(value))).unwrap_err();
            assert!(message.contains(&format!("{value:?}")), "{message}");
            assert!(message.contains("\"normal\" or \"panel\""), "{message}");
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_panel_does_not_activate_the_app_and_a_normal_window_does() {
        assert!(!activates_application(&gpui::WindowKind::Panel, true));
        assert!(activates_application(&gpui::WindowKind::Normal, true));
        assert!(!activates_application(&gpui::WindowKind::Normal, false));
        assert!(!activates_application(&gpui::WindowKind::Panel, false));
    }
}
