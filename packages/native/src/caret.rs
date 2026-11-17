//! The caret of a text input and of an editing host: its shape and its blink.
//!
//! Both blink the way Chrome's does: solid from the last activity (a keystroke, a move, focus coming), then
//! off and on every [`CARET_BLINK_MS`]. Neither polls: the owner waits for the end of the phase it is in
//! ([`until_phase_change`]) and asks the window for a tick then, so a caret nobody sees asks for no frame.

use std::time::Duration;

use gpui::{px, size, Bounds, Pixels, Point};

pub const CARET_BLINK_MS: u64 = 500;
pub const CARET_WIDTH: Pixels = px(2.0);

/// Whether the caret is lit `ms_since_activity` after it was last solid.
pub fn caret_visible(ms_since_activity: u64) -> bool {
    (ms_since_activity / CARET_BLINK_MS) % 2 == 0
}

/// How long the phase `ms_since_activity` is in has left.
pub fn until_phase_change(ms_since_activity: u64) -> Duration {
    Duration::from_millis(CARET_BLINK_MS - ms_since_activity % CARET_BLINK_MS)
}

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
    fn caret_blink_phase() {
        assert!(caret_visible(0));
        assert!(caret_visible(CARET_BLINK_MS - 1));
        assert!(!caret_visible(CARET_BLINK_MS));
        assert!(!caret_visible(2 * CARET_BLINK_MS - 1));
        assert!(caret_visible(2 * CARET_BLINK_MS));
    }

    #[test]
    fn the_wait_ends_at_the_next_phase_boundary() {
        assert_eq!(until_phase_change(0), Duration::from_millis(CARET_BLINK_MS));
        assert_eq!(until_phase_change(CARET_BLINK_MS - 1), Duration::from_millis(1));
        assert_eq!(until_phase_change(CARET_BLINK_MS), Duration::from_millis(CARET_BLINK_MS));
        assert_eq!(until_phase_change(3 * CARET_BLINK_MS + 120), Duration::from_millis(CARET_BLINK_MS - 120));
    }

    #[test]
    fn caret_matches_the_line_height() {
        let bounds = caret_rect(point(px(10.0), px(4.0)), px(20.0));
        assert_eq!(bounds.origin, point(px(10.0), px(4.0)));
        assert_eq!(bounds.size, size(px(2.0), px(20.0)));
    }
}
