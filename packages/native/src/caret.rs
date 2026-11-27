//! The caret of a text input and of an editing host: its shape.
//!
//! Both blink the way Chrome's does (solid from the last activity, then off and on every half second), and
//! gpui owns the blink: they paint through `Window::paint_caret` with the instant the blink restarted, which
//! a window shows as a layer its compositor animates, or draws lit and transparent itself. The owner ticks
//! only when the window says it cannot (`paint_caret` returns `true`): then it waits for the end of the phase
//! it is in (`gpui::until_phase_change`) and asks for a frame that paints the caret again.

use gpui::{px, size, Bounds, Pixels, Point};

pub const CARET_WIDTH: Pixels = px(2.0);

// Chrome paints the caret at line height, not font size. Firefox uses the em
// square after you type. Match Chrome so a 14/20 composer bar is 20px tall.
pub fn caret_rect(origin: Point<Pixels>, line_height: Pixels) -> Bounds<Pixels> {
    Bounds::new(origin, size(CARET_WIDTH, line_height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::point;

    #[test]
    fn caret_matches_the_line_height() {
        let bounds = caret_rect(point(px(10.0), px(4.0)), px(20.0));
        assert_eq!(bounds.origin, point(px(10.0), px(4.0)));
        assert_eq!(bounds.size, size(px(2.0), px(20.0)));
    }
}
