//! `GPUIX_BACKGROUND=1`: a window opened with it behaves as active for focus.
//!
//! A window that is not key fires no focus events, as in Chrome. An agent that drives an app
//! behind the user's work cannot take the keyboard to make it key, so the window emulates focus
//! the way CDP's `Emulation.setFocusEmulationEnabled` does: `onFocus`, `onBlur`,
//! `:focus-visible`, the caret and `focusElement` work, while the window stays not key and the
//! application is not activated. The single switch is `gpui::Window::set_focus_emulation`.

use gpui::{App, Window};

const VARIABLE: &str = "GPUIX_BACKGROUND";

fn requested(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Reads the variable once, at window creation: a window does not change when the process
/// environment does later.
pub(crate) fn apply(window: &mut Window, cx: &mut App) {
    apply_if(
        requested(std::env::var(VARIABLE).ok().as_deref()),
        window,
        cx,
    );
}

fn apply_if(emulate: bool, window: &mut Window, cx: &mut App) {
    if emulate {
        window.set_focus_emulation(true, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{AppContext as _, Context, IntoElement, Render, TestAppContext, div};

    struct Blank;

    impl Render for Blank {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }

    #[test]
    fn only_the_value_1_asks_for_emulation() {
        assert!(requested(Some("1")));
        assert!(!requested(Some("0")));
        assert!(!requested(Some("true")));
        assert!(!requested(Some("")));
        assert!(!requested(None));
    }

    #[gpui::test]
    fn an_emulating_window_answers_the_focus_paths_as_active(cx: &mut TestAppContext) {
        let plain = cx.add_window(|_, _| Blank);
        let emulating = cx.add_window(|_, _| Blank);
        cx.update_window(plain.into(), |_, window, cx| apply_if(false, window, cx))
            .unwrap();
        cx.update_window(emulating.into(), |_, window, cx| apply_if(true, window, cx))
            .unwrap();

        let active = |handle: gpui::AnyWindowHandle, cx: &mut TestAppContext| {
            cx.update_window(handle, |_, window, _| window.is_window_active())
                .unwrap()
        };
        assert!(
            !active(plain.into(), cx),
            "the variable unset leaves it alone"
        );
        assert!(
            active(emulating.into(), cx),
            "focus.rs and the caret ask this"
        );
    }
}
