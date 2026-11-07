//! Selectable text: the shared foundation for every text GPUIX paints.
//!
//! Ported from Comet (https://github.com/zeronsh/comet), MIT.
//!
//! Every text node in GPUIX goes through [`paint::selectable_text`], so a drag
//! can start in a plain `<text>` and end inside a `<code>` block. That only
//! works because all of them register into the same per-frame registry in paint
//! order. Adding a new text-painting element means calling that helper, never
//! `div().child(string)`.

pub mod atomic;
pub mod empty_box;
mod in_place;
pub mod inline;
pub mod inline_bounds;
pub mod inline_cursor;
pub mod inline_decoration;
pub mod inline_focus;
pub mod inline_hit;
pub mod inline_insets;
pub mod inline_region;
pub mod paint;
pub mod paragraph;
pub mod runs;
pub mod search;
pub mod selection;
pub mod white_space;

/// A subtree that was replayed puts back what it wrote into the registries of the frame.
pub(crate) fn publish(window: gpui::WindowId, live: &crate::tape::Live) {
    paint::publish(window, live);
    inline_hit::publish(window, live);
}

/// A patch laid out a root again: the registries give what its last build wrote for what the patch wrote.
pub(crate) fn replace(window: gpui::WindowId, old: &crate::tape::Roots, new: &[crate::tape::Live]) {
    paint::replace(window, old, new);
    inline_hit::replace(window, old, new);
}

/// A frame brought rows in: what they wrote goes where the rows of each of `rows`, in the order of their list, have theirs.
pub(crate) fn order_by_rows(window: gpui::WindowId, rows: &[crate::tape::Roots]) {
    paint::order_by_rows(window, rows);
    inline_hit::order_by_rows(window, rows);
}

pub(crate) use paint::{describe_registries, shift};
pub(crate) use paint::{
    describe_start_region_apart_from_transform, describe_text_apart_from_transform, publish_captured_start_region,
    publish_captured_text,
};
pub use paint::{
    chrome_text, log_painted_text, painted_highlights, painted_text, range_rects,
    record_start_region, selectable_text, selection_frame_reset, selection_key, HighlightSource,
    PaintedHighlight, SelectableText, SharedSelection,
};
pub use search::{GroupList, HighlightContext, HighlightSet};
