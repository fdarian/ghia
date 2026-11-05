//! A scroll write (`scrollTo`, `scrollTop = n`) reads nothing and lays nothing out.
//!
//! A browser's setter lays out what is pending so it can clamp to the layout's range. Here that
//! layout is a whole draw of the page, and the frame that follows it draws the page again. A write
//! made while the layout is older than the tree (a mutation since the last pass) is therefore
//! recorded, and the layout that comes next makes it: a container's offset is set when the next
//! frame starts to build, so the build sees it as it sees a wheel's, and the scroller clamps it in
//! its prepaint ([`settle_containers`]); a list is written again once that render has spliced its
//! rows ([`settle_lists`]). A read still lays out when something it reads is dirty, so a write
//! followed by a read gives the clamped value.
//!
//! Where the order of the DOM matters, the write lays out first (see [`lays_out_first`]).
//!
//! "Older than the tree" is known from [`gpui::LayoutStamp`]: the stamp of the last render, and of
//! the writes since that kept the metrics current, is the last at which the range was the tree's.
//! A write with no layout invalidation since it is clamped at once, as it always was.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use crate::scroll;

thread_local! {
    /// The stamp at which the scroll metrics of every scroller were last known to be the tree's.
    static CURRENT_AT: Cell<Option<gpui::LayoutStamp>> = const { Cell::new(None) };
    /// The offsets written to a container while its layout was behind the tree, whole device pixels.
    static PENDING_CONTAINER_WRITES: RefCell<HashMap<u64, gpui::Point<gpui::Pixels>>> =
        RefCell::new(HashMap::new());
    /// The offsets written to a list while its layout was behind the tree, whole device pixels.
    static PENDING_LIST_WRITES: RefCell<HashMap<u64, gpui::Point<gpui::Pixels>>> =
        RefCell::new(HashMap::new());
}

/// Records that the scroll metrics are the tree's as of now. A render calls it: the layout of its
/// pass follows, and an invalidation after it is not covered.
pub(crate) fn note_metrics_current(window: &gpui::Window) {
    CURRENT_AT.with(|current| current.set(Some(window.layout_stamp())));
}

/// Whether no layout invalidation came since [`note_metrics_current`]. A scroll write counts as
/// one; [`finish_write`] takes its own back.
pub(crate) fn metrics_current(window: &gpui::Window) -> bool {
    CURRENT_AT.with(|current| {
        current
            .get()
            .is_some_and(|stamp| stamp.same_invalidations(&window.layout_stamp()))
    })
}

/// What the renderer holds for the element a write is aimed at.
pub(crate) enum ScrollerState<'a> {
    Container(&'a gpui::ScrollHandle),
    List,
    /// No scroll state: the element is not a scroller, or it was mounted since the last render.
    Unbuilt,
}

/// Whether a write lays out what is dirty first, as a browser's setter does.
///
/// A smooth scroll animates to a target that is clamped when it starts, and a scroller mounted
/// since the last render has nothing to write to before the layout builds it.
///
/// A container written to another vertical position than the one it holds, other than the start,
/// needs the layout first as well: scroll anchoring picks its anchor at the offset a layout starts
/// with and compensates after it, and the DOM's order is the layout (which compensates at the old
/// offset), then the write, whose target the compensation must not move. A write to the start (no
/// anchor is picked at 0), or one that leaves the vertical position, is the same either way. A list
/// has no anchoring and is written again once its rows are spliced.
pub(crate) fn lays_out_first(
    metrics_current: bool,
    id: u64,
    scroller: ScrollerState<'_>,
    top: Option<f64>,
    behavior: scroll::Behavior,
) -> bool {
    if scroll::is_smooth(id, behavior) {
        return true;
    }
    if metrics_current {
        return false;
    }
    let handle = match scroller {
        ScrollerState::Container(handle) => handle,
        ScrollerState::List => return false,
        ScrollerState::Unbuilt => return true,
    };
    let Some(top) = top else {
        return false;
    };
    let held = PENDING_CONTAINER_WRITES
        .with(|pending| pending.borrow().get(&id).copied())
        .unwrap_or_else(|| handle.offset());
    let held = scroll::dom_position(held, handle.scale_factor())[1];
    let target = scroll::dom_position(scroll::gpui_offset(0.0, top), handle.scale_factor())[1];
    target != 0.0 && target != held
}

/// Invalidates the window for a write that moved a scroller. `was_current` is [`metrics_current`]
/// from before the write: the invalidation moves no extent, so the metrics stay current.
pub(crate) fn finish_write(
    window: &gpui::Window,
    cx: &mut gpui::App,
    view: gpui::EntityId,
    was_current: bool,
) {
    crate::renderer::invalidate_after_scroll(cx, view);
    if was_current {
        note_metrics_current(window);
    }
}

/// Writes a scroll container. An axis left out keeps the offset the handle holds, or the one an
/// earlier write recorded. Returns whether the scroller moved, or will.
pub(crate) fn write_container(
    metrics_current: bool,
    id: u64,
    handle: &gpui::ScrollHandle,
    left: Option<f64>,
    top: Option<f64>,
    behavior: scroll::Behavior,
) -> bool {
    let recorded = PENDING_CONTAINER_WRITES.with(|pending| pending.borrow().get(&id).copied());
    let held = recorded.unwrap_or_else(|| handle.offset());
    let position = scroll::dom_position(held, handle.scale_factor());
    let offset = scroll::gpui_offset(left.unwrap_or(position[0]), top.unwrap_or(position[1]));
    if metrics_current || scroll::is_smooth(id, behavior) {
        PENDING_CONTAINER_WRITES.with(|pending| pending.borrow_mut().remove(&id));
        return scroll::scroll_to(id, handle, offset, behavior);
    }
    scroll::end_smooth_scroll(id);
    let target = scroll::snapped_offset(offset, handle.scale_factor());
    if target == held {
        return false;
    }
    PENDING_CONTAINER_WRITES.with(|pending| pending.borrow_mut().insert(id, target));
    true
}

/// Whether a write to the container `id` waits for the next layout, which a read of its offset
/// has to lay out for, as a read of `scrollTop` does.
pub(crate) fn has_pending_container(id: u64) -> bool {
    PENDING_CONTAINER_WRITES.with(|pending| pending.borrow().contains_key(&id))
}

/// Called when a render starts, before it builds anything and before the layout it is followed by
/// clamps the offset: the writes recorded since the last render are made.
pub(crate) fn settle_containers(handles: &HashMap<u64, gpui::ScrollHandle>) {
    let pending = PENDING_CONTAINER_WRITES.with(|pending| std::mem::take(&mut *pending.borrow_mut()));
    for (id, offset) in pending {
        if let Some(handle) = handles.get(&id) {
            handle.set_offset(offset);
        }
    }
}

/// Writes a virtual list, which has no horizontal offset. It is written to the list as it stands,
/// so the paths that read the state see the write, and again by [`settle_lists`] when the layout
/// was behind the tree, since a pixel position is converted against the rows the list has.
pub(crate) fn write_list(
    metrics_current: bool,
    id: u64,
    state: &gpui::ListState,
    top: Option<f64>,
) -> bool {
    let Some(top) = top else {
        return false;
    };
    crate::renderer::cancel_queued_list_scroll(id);
    let target = scroll::gpui_offset(0.0, top);
    let before = state.scroll_px_offset_for_scrollbar();
    let moved = scroll::scroll_list_to(state, target);
    let snapped = scroll::snapped_offset(target, state.scale_factor());
    PENDING_LIST_WRITES.with(|pending| {
        let mut pending = pending.borrow_mut();
        let settles = !metrics_current && (snapped != before || pending.contains_key(&id));
        if settles {
            pending.insert(id, snapped);
        } else {
            pending.remove(&id);
        }
        moved || settles
    })
}

/// Called when the rows of a frame are spliced, before its layout: the writes recorded since the
/// last one are made again against the rows the layout will measure.
pub(crate) fn settle_lists(states: &HashMap<u64, gpui::ListState>) {
    let pending = PENDING_LIST_WRITES.with(|pending| std::mem::take(&mut *pending.borrow_mut()));
    for (id, offset) in pending {
        if let Some(state) = states.get(&id) {
            scroll::scroll_list_to(state, offset);
        }
    }
}

/// A scroll to a row queued for the list supersedes a pixel write made before it.
pub(crate) fn forget_list_write(id: u64) {
    PENDING_LIST_WRITES.with(|pending| pending.borrow_mut().remove(&id));
}
