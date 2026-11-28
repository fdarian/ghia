//! What gpui asks of Ghia before it classifies the frame drawn after a list scroll
//! (`Window::set_scroll_patch_gate`): whether the tree is the one the frame shown was built from,
//! whether something that follows the clock asked the last frame for another (`ClockAsked`), and
//! whether an animation of the scroll has frames of its own to run, or the bar of a scroll container is due one (the bars of a
//! list are planned by the bar, `scrollbar::plan_thumb`, through `Window::paint_scroll_thumb`). The hover under a still pointer
//! is not asked: a scroll does not recompute it (`events/hover_after_scroll.rs`). The classifier is in zed
//! (`window/scroll_patch.rs`); see [patch-frames.md](../../../../docs/fork/patch-frames.md).

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use rustc_hash::FxHashSet;

use gpui::ScrollPatchReason;

use super::Retain;
use crate::renderer::GpuixView;

thread_local! {
    /// The views whose window classifies the frames after a list scroll.
    static CLASSIFYING: RefCell<FxHashSet<gpui::EntityId>> = Default::default();
}

/// Turns the classification of the frames after a list scroll on or off for the window of `view`.
pub(crate) fn set_scroll_patch(window: &mut gpui::Window, view: gpui::EntityId, enabled: bool) {
    window.set_scroll_patch(enabled);
    CLASSIFYING.with(|views| {
        if enabled {
            views.borrow_mut().insert(view);
        } else {
            views.borrow_mut().remove(&view);
        }
    });
}

/// Whether the draw that follows a write to a list's offset is asked for by `Window::note_list_scrolled` alone, which
/// does not notify the view: only a window that classifies the frame draws the list again when it declines.
pub(crate) fn list_write_is_quiet(view: gpui::EntityId) -> bool {
    CLASSIFYING.with(|views| views.borrow().contains(&view))
}

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

    /// A patch drew the tree as it is at `revision`: the frame shown is the frame of that revision, so a list scroll noted in
    /// the draw of the patch is classified against it. Only a frame that was shown whole has anything to say it of.
    pub(crate) fn note_patched(&self, revision: u64) {
        if self.shown.0.get().is_some() {
            self.shown.0.set(Some(revision));
        }
    }

    /// Says what the frame shown is, after anything that changes it.
    pub(super) fn publish_shown(&self) {
        let whole = self.planning && self.plan.recorded && !self.plan.layout_since && !self.plan.unsteady;
        self.shown.0.set(whole.then_some(self.plan.revision));
    }
}

/// What the gate of a window reads: the frame shown, and the tree it was built from.
#[derive(Clone)]
struct ScrollGate {
    shown: ShownFrame,
    clock_asked: ClockAsked,
    tree: std::sync::Arc<std::sync::Mutex<crate::retained_tree::RetainedTree>>,
    tapes: crate::tape::Tapes,
    view: gpui::WeakEntity<GpuixView>,
}

/// What the gate says of the frame, and the roots the commit took out of the tree that it did not count as an edit.
struct GateAnswer {
    reason: Option<ScrollPatchReason>,
    removed: Vec<u64>,
    /// The children of the parents they left, which stay.
    survivors: Vec<u64>,
}

impl ScrollGate {
    fn answer(&self, window: &gpui::Window, cx: &gpui::App, translating: Option<gpui::ScrollKey>, accepts_removals: bool) -> GateAnswer {
        let reason = |reason| GateAnswer { reason: Some(reason), removed: Vec::new(), survivors: Vec::new() };
        let Some(revision) = self.shown.0.get() else {
            return reason(ScrollPatchReason::Other);
        };
        let window_id = window.window_handle().window_id();
        // A tree locked by an update is being edited.
        let (removed, survivors) = {
            let Ok(tree) = self.tree.try_lock() else {
                return reason(ScrollPatchReason::Edited);
            };
            if tree.root_revision() == revision {
                (Vec::new(), Vec::new())
            } else {
                let pairs = accepts_removals.then(|| tree.pure_removals_since(revision)).flatten();
                let Some((removed, survivors)) = pairs.and_then(|pairs| tree.what_stays_of(&pairs)) else {
                    return reason(ScrollPatchReason::Edited);
                };
                if !removals_leave_the_rest(window_id, &removed) || !self.tapes.can_remove(&removed.iter().map(|(child, _)| *child).collect::<Vec<_>>(), &survivors) {
                    return reason(ScrollPatchReason::Edited);
                }
                (removed.into_iter().map(|(child, _)| child).collect(), survivors)
            }
        };
        let answer = |reason: Option<ScrollPatchReason>| GateAnswer { reason, removed: removed.clone(), survivors: survivors.clone() };
        if crate::scroll::animating_in(window_id) || crate::scrollbar::needs_frames(window_id) {
            return answer(Some(ScrollPatchReason::ScrollAnimation));
        }
        // A translate builds nothing, so it would leave what runs where the last frame left it.
        if self.clock_asked.0.get() {
            return answer(Some(ScrollPatchReason::Clock));
        }
        // The view notifies for other sources than the tree too (a press that restyles, a selection, a
        // measurement, a link, a command), and the list's notify is the same entity's: the sources are
        // compared as a tick's are, and what differs besides the scroll is a frame built whole.
        let Some(view) = self.view.upgrade().filter(|view| !view.is_updating(cx)) else {
            return answer(Some(ScrollPatchReason::Edited));
        };
        if view.read(cx).sources_besides_scroll_changed(window, translating) {
            return answer(Some(ScrollPatchReason::Edited));
        }
        answer(crate::scrollbar::container_bar_stale(window_id).then_some(ScrollPatchReason::Thumb))
    }
}

/// Whether taking the children `removed` (each with the parent it left) out of the frame shown leaves it as the commit does:
/// the scrollable overflow of what holds them does not shrink. A child's box is inside its parent's, so the box that
/// reaches furthest is not theirs. A box that is not known is not inside.
fn removals_leave_the_rest(window: gpui::WindowId, removed: &[(u64, u64)]) -> bool {
    const SLACK: f64 = 0.5;
    removed.iter().all(|(child, parent)| {
        let (Some(child), Some(parent)) = (crate::automation::get_bounds(window, *child), crate::automation::get_bounds(window, *parent)) else {
            return false;
        };
        let (child, parent) = (child.window_box(), parent.window_box());
        child.0 >= parent.0 - SLACK
            && child.1 >= parent.1 - SLACK
            && child.0 + child.2 <= parent.0 + parent.2 + SLACK
            && child.1 + child.3 <= parent.1 + parent.3 + SLACK
    })
}

impl GpuixView {
    /// Whether a source other than the scroll of the scroller `translating` differs from the frame shown, see
    /// `Retain::sources_changed`. What cannot be read is a change.
    fn sources_besides_scroll_changed(&self, window: &gpui::Window, translating: Option<gpui::ScrollKey>) -> bool {
        if self.pointer.try_borrow().is_err() {
            return true;
        }
        self.with_sources(window, self.clock.now(), |sources, _| self.retain.sources_changed(sources, translating))
    }

    /// Turns the classification on unless `GPUIX_SCROLL_PATCH_OFF`, and gives gpui the gate. Once.
    pub(super) fn install_scroll_gate(&mut self, window: &mut gpui::Window, view: gpui::WeakEntity<GpuixView>) {
        set_scroll_patch(window, view.entity_id(), std::env::var_os("GPUIX_SCROLL_PATCH_OFF").is_none());
        let reports = self.paint_reports.clone();
        let sweep_tree = self.tree.clone();
        let callback = self.event_callback.clone();
        let settled_tapes = self.tapes.clone();
        let settled_view = view.clone();
        let hover = self.hover_after_scroll.clone();
        window.set_scroll_patch_settled(Some(Rc::new(move |window: &mut gpui::Window, cx: &mut gpui::App, translated: gpui::ScrollKey| {
            // The rows that left are out of the registries before the sweeps read the boxes, and out of
            // the page's records before a frame builds a row that comes in again. So are the children a commit took out
            // of the scroller, which the frame was drawn without.
            let removals_drawn = settled_tapes.settle_rows(window.window_handle().window_id());
            crate::renderer::list_writes_drawn(window.window_handle().window_id());
            if let Some(view) = settled_view.upgrade().filter(|view| !view.is_updating(cx)) {
                view.update(cx, |view, _| {
                    view.forget_left_rows();
                    view.note_scrolls_translated(translated);
                    if removals_drawn {
                        view.note_removals_drawn();
                    }
                });
            }
            // A translate under a wheel leaves the hover where it was: it follows when the scroll ends.
            if hover.follows_translate(window.window_handle().window_id()) {
                hover.follow(window, cx);
            }
            crate::observers::sweep_after_translate(window.window_handle(), window.viewport_size(), &reports, &sweep_tree, &callback, cx);
        })));
        let gate_tapes = self.tapes.clone();
        let gate = ScrollGate {
            shown: self.retain.shown.clone(),
            clock_asked: self.retain.clock_asked.clone(),
            tree: self.tree.clone(),
            tapes: self.tapes.clone(),
            view: view.clone(),
        };
        window.set_scroll_patch_gate(Some(Rc::new({
            let gate = gate.clone();
            move |window: &gpui::Window, cx: &gpui::App, translating: Option<gpui::ScrollKey>| {
                gate_tapes.fold_rows(window.window_handle().window_id());
                gate.answer(window, cx, translating, false).reason
            }
        })));
        // A commit that only took children out of the tree is no edit for a scroll of a `div` that moves what held them.
        window.set_scroll_patch_removals(Some(Rc::new(move |window: &gpui::Window, cx: &gpui::App, translating: Option<gpui::ScrollKey>| {
            let answer = gate.answer(window, cx, translating, true);
            if answer.removed.is_empty() {
                return None;
            }
            gate.tapes.note_removed(&answer.removed, &answer.survivors);
            Some(gpui::ScrollRemovals {
                removed: answer.removed.iter().map(|root| crate::renderer::retained_id(*root)).collect(),
                gate: answer.reason,
            })
        })));
    }
}
