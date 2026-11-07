//! What gpui asks of Ghia before it classifies the frame drawn after a list scroll
//! (`Window::set_scroll_patch_gate`): whether the tree is the one the frame shown was built from,
//! whether something that follows the clock asked the last frame for another (`ClockAsked`), and
//! whether an animation of the scroll has frames of its own to run, or the bar of a scroll container is due one (the bars of a
//! list are planned by the bar, `scrollbar::plan_thumb`, through `Window::paint_scroll_thumb`). And what a hit chain that
//! a scroll changes would do to the pointer (`Window::set_scroll_patch_hover`): restyle an
//! element or reach a listener, or nothing. The classifier is in zed
//! (`window/scroll_patch.rs`); see [patch-frames.md](../../../../docs/fork/patch-frames.md).

use std::cell::Cell;
use std::rc::Rc;

use gpui::ScrollPatchReason;

use super::Retain;
use crate::renderer::GpuixView;

/// The revision of the tree that the frame shown was built whole from. Nothing while there is no
/// such frame: planning is off, no frame was recorded, a pass that only lays out ran since (it takes
/// the changes it saw), or the frame built an element that follows the clock.
#[derive(Clone, Default)]
pub(crate) struct ShownFrame(Rc<Cell<Option<u64>>>);

impl ShownFrame {
    #[cfg(test)]
    pub(super) fn get(&self) -> Option<u64> {
        self.0.get()
    }
}

/// Whether the last frame that ran (a build or a patched tick) asked for another because something
/// follows the clock: a transition, an animation, motion, a motion value that wants frames.
#[derive(Clone, Default)]
pub(crate) struct ClockAsked(Rc<Cell<bool>>);

impl Retain {
    /// Says whether the frame that ran asked for the next one.
    pub(crate) fn note_clock_asked(&self, asked: bool) {
        self.clock_asked.0.set(asked);
    }

    /// Says what the frame shown is, after anything that changes it.
    pub(super) fn publish_shown(&self) {
        let whole = self.planning && self.plan.recorded && !self.plan.layout_since && !self.plan.unsteady;
        self.shown.0.set(whole.then_some(self.plan.revision));
    }
}

impl GpuixView {
    /// Whether a source other than the scroll of a list differs from the frame shown, see
    /// `Retain::sources_changed`. What cannot be read is a change.
    fn sources_besides_scroll_changed(&self, window: &gpui::Window) -> bool {
        if self.pointer.try_borrow().is_err() {
            return true;
        }
        self.with_sources(window, self.clock.now(), |sources, _| self.retain.sources_changed(sources))
    }

    /// Turns the classification on unless `GPUIX_SCROLL_PATCH_OFF`, and gives gpui the gate. Once.
    pub(super) fn install_scroll_gate(&mut self, window: &mut gpui::Window, view: gpui::WeakEntity<GpuixView>) {
        window.set_scroll_patch(std::env::var_os("GPUIX_SCROLL_PATCH_OFF").is_none());
        let shown = self.retain.shown.clone();
        let clock_asked = self.retain.clock_asked.clone();
        let tree = self.tree.clone();
        let hover_tree = self.tree.clone();
        let pointer = self.pointer.clone();
        window.set_scroll_patch_hover(Some(Rc::new(
            move |_: &gpui::Window, before: &[gpui::GlobalElementId], after: &[gpui::GlobalElementId]| {
                // What cannot be read is a pointer that may matter.
                let (Ok(tree), Ok(pointer)) = (hover_tree.try_lock(), pointer.try_borrow()) else {
                    return true;
                };
                // The target of a hit chain, as `dispatch_at` takes it.
                let target = |chain: &[gpui::GlobalElementId]| {
                    chain
                        .iter()
                        .filter_map(|id| id.last().and_then(crate::events::ids::host_id_of))
                        .find(|id| tree.elements.contains_key(id))
                };
                crate::events::dispatcher::hover_would_matter(&pointer, &tree, target(before), target(after))
            },
        )));
        let settled = self.pointer.clone();
        let reports = self.paint_reports.clone();
        let sweep_tree = self.tree.clone();
        let callback = self.event_callback.clone();
        window.set_scroll_patch_settled(Some(Rc::new(move |window: &mut gpui::Window, cx: &mut gpui::App| {
            let settle = settled
                .borrow()
                .scroll_settle
                .clone()
                .expect("a frame that moves the rows has the pointer frame of the frame shown");
            settle(window, cx);
            crate::observers::sweep_after_translate(window.window_handle(), window.viewport_size(), &reports, &sweep_tree, &callback, cx);
        })));
        window.set_scroll_patch_gate(Some(Rc::new(move |window: &gpui::Window, cx: &gpui::App| {
            let Some(revision) = shown.0.get() else {
                return Some(ScrollPatchReason::Other);
            };
            // A tree locked by an update is being edited.
            let current = {
                let Ok(tree) = tree.try_lock() else {
                    return Some(ScrollPatchReason::Edited);
                };
                tree.root_id
                    .and_then(|id| tree.elements.get(&id))
                    .map_or(0, |root| root.subtree_revision)
            };
            if current != revision {
                return Some(ScrollPatchReason::Edited);
            }
            if crate::scroll::animating() || crate::scrollbar::needs_frames() {
                return Some(ScrollPatchReason::ScrollAnimation);
            }
            // A translate builds nothing, so it would leave what runs where the last frame left it.
            if clock_asked.0.get() {
                return Some(ScrollPatchReason::Clock);
            }
            // The view notifies for other sources than the tree too (a press that restyles, a selection, a
            // measurement, a link, a command), and the list's notify is the same entity's: the sources are
            // compared as a tick's are, and what differs besides the scroll is a frame built whole.
            let Some(view) = view.upgrade().filter(|view| !view.is_updating(cx)) else {
                return Some(ScrollPatchReason::Edited);
            };
            if view.read(cx).sources_besides_scroll_changed(window) {
                return Some(ScrollPatchReason::Edited);
            }
            crate::scrollbar::container_bar_stale().then_some(ScrollPatchReason::Thumb)
        })));
    }
}
