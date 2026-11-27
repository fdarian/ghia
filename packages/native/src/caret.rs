//! The caret of a text input and of an editing host: its shape.
//!
//! Both blink the way Chrome's does (solid from the last activity, then off and on every half second), and
//! gpui owns the blink: they paint through `Window::paint_caret` with the instant the blink restarted, which
//! a window shows as a layer its compositor animates, or draws lit and transparent itself. The owner ticks
//! only when the window says it cannot (`paint_caret` returns `true`): then it waits for the end of the phase
//! it is in (`gpui::until_phase_change`) and asks for a frame that paints the caret again.

use std::cell::Cell;

use gpui::{px, size, Bounds, Pixels, Point, Window};

use crate::custom_elements::CustomElementRegistry;
use crate::editing::caret::EditingCaret;

pub const CARET_WIDTH: Pixels = px(2.0);

// Chrome paints the caret at line height, not font size. Firefox uses the em
// square after you type. Match Chrome so a 14/20 composer bar is 20px tall.
pub fn caret_rect(origin: Point<Pixels>, line_height: Pixels) -> Bounds<Pixels> {
    Bounds::new(origin, size(CARET_WIDTH, line_height))
}

/// Whether the last frame the window showed has a caret that the window stopped blinking and the page
/// has to: the one view state of a window that `hand_over` needs.
#[derive(Default)]
pub struct Handover {
    ticked: Cell<bool>,
}

impl Handover {
    /// Whether the window has started asking the page to tick a caret since the last call. A caret
    /// that comes up like that was on the layer, or blinked by the window, and was not painted again:
    /// what the window became composed, or a recording replayed in an effect group, did to it.
    fn arrived(&self, window: &Window) -> bool {
        let ticks = window.caret_needs_ticks();
        let was = self.ticked.replace(ticks);
        ticks && !was
    }
}

/// When the window hands the blink of a caret over to the page, makes the owners of the caret due:
/// the frame the window asks for then builds them (they are replayed otherwise, with the painter that
/// did not arm a tick), their painters read `Window::caret_needs_ticks` and keep blinking. Every
/// input is marked, since which one holds the focus is not known here, and only the one that shows a
/// caret has a painter that blinks; the others clear it the next time they are painted.
pub fn hand_over(handover: &Handover, window: &Window, inputs: &CustomElementRegistry, editing: &EditingCaret) {
    if handover.arrived(window) {
        inputs.repaint_clocks();
        editing.repaint();
    }
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
