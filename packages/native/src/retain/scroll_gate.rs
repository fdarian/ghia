//! What gpui asks of Ghia before it classifies the frame drawn after a list scroll
//! (`Window::set_scroll_patch_gate`): whether the tree is the one the frame shown was built from,
//! and whether an animation of the scroll has frames of its own to run. The classifier is in zed
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

impl Retain {
    /// Says what the frame shown is, after anything that changes it.
    pub(super) fn publish_shown(&self) {
        let whole = self.planning && self.plan.recorded && !self.plan.layout_since && !self.plan.unsteady;
        self.shown.0.set(whole.then_some(self.plan.revision));
    }
}

impl GpuixView {
    /// Turns the classification on unless `GPUIX_SCROLL_PATCH_OFF`, and gives gpui the gate. Once.
    pub(super) fn install_scroll_gate(&mut self, window: &mut gpui::Window) {
        window.set_scroll_patch(std::env::var_os("GPUIX_SCROLL_PATCH_OFF").is_none());
        let shown = self.retain.shown.clone();
        let tree = self.tree.clone();
        window.set_scroll_patch_gate(Some(Rc::new(move |_: &gpui::Window| {
            let Some(revision) = shown.0.get() else {
                return Some(ScrollPatchReason::Other);
            };
            // A tree locked by an update is being edited.
            let Ok(tree) = tree.try_lock() else {
                return Some(ScrollPatchReason::Edited);
            };
            let current = tree
                .root_id
                .and_then(|id| tree.elements.get(&id))
                .map_or(0, |root| root.subtree_revision);
            if current != revision {
                return Some(ScrollPatchReason::Edited);
            }
            if crate::scroll::animating() || crate::scrollbar::needs_frames() {
                return Some(ScrollPatchReason::ScrollAnimation);
            }
            None
        })));
    }
}
