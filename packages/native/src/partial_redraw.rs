//! `GPUIX_PARTIAL_REDRAW=1`: a window opened with it draws only the part of the picture that a frame
//! changed, where the platform can (`gpui::Window::set_partial_redraw`). Off by default; see
//! docs/fork/paint-and-transforms.md ("Partial redraw").

use gpui::Window;

const VARIABLE: &str = "GPUIX_PARTIAL_REDRAW";

fn requested(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Reads the variable once, at window creation.
pub(crate) fn apply(window: &mut Window) {
    if requested(std::env::var(VARIABLE).ok().as_deref()) {
        window.set_partial_redraw(true);
    }
}

#[cfg(test)]
mod tests {
    use super::requested;

    #[test]
    fn only_the_value_1_asks_for_it() {
        assert!(requested(Some("1")));
        assert!(!requested(Some("0")));
        assert!(!requested(Some("true")));
        assert!(!requested(None));
    }
}
