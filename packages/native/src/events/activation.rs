//! A `click` that has been delivered, and the activation behaviour that follows
//! it, unless a handler cancelled the click. The activation target is the first element on its
//! path with an activation behaviour (`html::activation_target`), and only that behaviour runs: a
//! `<label>` focuses its control and clicks it, a `<button>` submits its form, and an `<a href>`
//! does nothing, since Ghia has no navigation.
//!
//! Three sources feed it: a pointer release, `element.click()` and a
//! VoiceOver Press. DOM runs the same activation behaviour for all of them.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use gpui::{App, Window};

use crate::accessibility::label;
use crate::element_tree::{EventModifiers, EventPayload};
use crate::renderer::{EventCallback, GpuixView};
use crate::retained_tree::RetainedTree;

use super::keyboard::InputRouting;
use super::state::PointerState;
use super::sync_dispatch;
use super::synthetic_click;

/// What a click needs to be delivered and activated, shared so that none of its
/// callers has to lease `GpuixView`.
#[derive(Clone)]
pub(crate) struct Activation {
    pub tree: Arc<Mutex<RetainedTree>>,
    pub callback: Option<EventCallback>,
    pub routing: InputRouting,
    /// The press chain a held Space sets `:active` on, as a pointer press does.
    pub pointer: Rc<RefCell<PointerState>>,
}

impl Activation {
    /// The activation behaviour of `click`, a click no handler cancelled: the
    /// control of the label on its path takes focus and gets a `click` of its
    /// own, aimed at it and carrying the original position and detail. That click is activated in
    /// turn when the control is a button, which submits its form.
    pub(crate) fn activate_label(&self, click: &EventPayload, window: &mut Window, cx: &mut App) {
        let path: Vec<u64> = click.path.iter().flatten().map(|id| *id as u64).collect();
        let activation = {
            let tree = self.tree.lock().unwrap();
            label::activated_control(&tree, &path)
                .map(|control| (control, label::activation_click(&tree, click, control)))
        };
        let Some((control, payload)) = activation else {
            return;
        };
        if let Some(handle) = self.routing.first_focusable(&[control]) {
            window.focus(&handle, cx);
        }
        let outcome = sync_dispatch::emit(window, cx, &self.callback, payload.clone());
        if !outcome.default_prevented {
            let path: Vec<u64> = payload.path.iter().flatten().map(|id| *id as u64).collect();
            crate::forms::button_clicked(&self.tree, &path, window, cx);
        }
    }

    /// The activation behaviour of `click`, a click no handler cancelled: that of its one activation
    /// target.
    pub(crate) fn activate(&self, click: &EventPayload, window: &mut Window, cx: &mut App) {
        let path: Vec<u64> = click.path.iter().flatten().map(|id| *id as u64).collect();
        let target = {
            let tree = self.tree.lock().unwrap();
            crate::html::activation_target(&tree, &path)
                .and_then(|id| tree.elements.get(&id))
                .map(|element| element.element_type.clone())
        };
        match target.as_deref() {
            Some("label") => self.activate_label(click, window, cx),
            Some("button") => crate::forms::button_clicked(&self.tree, &path, window, cx),
            _ => {}
        }
    }

    /// Delivers a click that no pointer made and then runs its activation
    /// behaviour, as `HTMLElement.click()` does. A handler that cancels the
    /// click keeps its activation from running, where the outcome is
    /// known (see `sync_dispatch::emit`).
    pub(crate) fn click(&self, click: EventPayload, window: &mut Window, cx: &mut App) {
        let outcome = sync_dispatch::emit(window, cx, &self.callback, click.clone());
        if !outcome.default_prevented {
            self.activate(&click, window, cx);
        }
    }

    /// `click` for the element `id` as the tree has it now, with `modifiers` held. Does nothing for
    /// a disabled form control.
    pub(crate) fn click_element(
        &self,
        id: u64,
        modifiers: Option<EventModifiers>,
        window: &mut Window,
        cx: &mut App,
    ) -> Result<(), String> {
        let click = {
            let tree = self.tree.lock().unwrap();
            synthetic_click::click_element(&tree, id)?
        };
        if let Some(click) = click {
            self.click(EventPayload { modifiers, ..click }, window, cx);
        }
        Ok(())
    }
}

/// `Activation::click_element` for the window's root view, with no modifiers held.
pub(crate) fn click_element(id: u64, window: &mut Window, cx: &mut App) -> Result<(), String> {
    click_element_with(id, None, window, cx)
}

/// `click_element` for a click that carries the modifiers held (Enter on a link). The view is read
/// for its shared state and not leased, because the click's handlers run inside this call and may
/// update it; when something else holds it, the click is made once that is done.
pub(crate) fn click_element_with(
    id: u64,
    modifiers: Option<EventModifiers>,
    window: &mut Window,
    cx: &mut App,
) -> Result<(), String> {
    let view = window
        .root::<GpuixView>()
        .flatten()
        .ok_or_else(|| "The window has no GpuixView".to_string())?;
    if view.is_updating(cx) {
        window.defer(cx, move |window, cx| {
            if let Err(error) = click_element_with(id, modifiers, window, cx) {
                sync_dispatch::report_deferred_error(error);
            }
        });
        return Ok(());
    }
    let activation = view.read(cx).activation();
    activation.click_element(id, modifiers, window, cx)
}
