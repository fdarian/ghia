//! A `click` that has been delivered, and the activation behaviour that follows
//! it, unless a handler cancelled the click. The activation target is the first element on its
//! path with an activation behaviour (`html::activation_target`), and only that behaviour runs: a
//! `<label>` focuses its control and clicks it, a `<button>` submits its form, and an `<a href>`
//! does nothing, since Ghia has no navigation.
//!
//! Three sources feed it: a pointer release, `element.click()` and a
//! VoiceOver Press. DOM runs the same activation behaviour for all of them.
//!
//! A checkbox or a radio is activated in three steps around the click (`input_choice`): it toggles
//! before the click's listeners run, a canceled click puts it back, and otherwise `input` and
//! `change` fire after it. `Activation::deliver_click` does all three for a click native makes, and
//! JS does them for a click an app dispatches (`preActivateElement`, `cancelActivation` and
//! `activateElement`).

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
    /// Makes the window draw what the tree changed on its own: the state of a choice control.
    fn invalidate(&self, window: &mut Window, cx: &mut App) {
        let dirty = self.tree.lock().unwrap().take_dirty();
        if let Some(view) = window.root::<GpuixView>().flatten() {
            crate::renderer::invalidate_after_mutation(window, cx, view.entity_id(), dirty);
        }
    }

    /// Legacy-pre-activation of the checkbox or radio that `click` activates, before its listeners
    /// run. Returns the control when it began one.
    pub(crate) fn pre_activate(&self, click: &EventPayload, window: &mut Window, cx: &mut App) -> Option<u64> {
        let path: Vec<u64> = click.path.iter().flatten().map(|id| *id as u64).collect();
        let control = {
            let mut tree = self.tree.lock().unwrap();
            let target = crate::html::activation_target(&tree, &path)?;
            tree.pre_activate(target).then_some(target)
        }?;
        self.invalidate(window, cx);
        Some(control)
    }

    /// Legacy-canceled-activation: a handler canceled the click `control` was toggled for.
    fn cancel_choice(&self, control: u64, window: &mut Window, cx: &mut App) {
        self.tree.lock().unwrap().cancel_activation(control);
        self.invalidate(window, cx);
    }

    /// The activation behaviour of a checkbox or radio, after its click: `input` and then
    /// `change`, both bubbling and not cancelable, when the click changed its checkedness. They are
    /// delivered with `emit`, so a handler has run when `click()` returns. A control that has a
    /// `checked` prop then shows that prop, as React DOM restores a controlled input.
    fn choice_activated(&self, control: u64, window: &mut Window, cx: &mut App) {
        let (changed, path) = {
            let mut tree = self.tree.lock().unwrap();
            (tree.finish_activation(control), super::path::event_path(&tree, control))
        };
        if !changed {
            return;
        }
        for event_type in ["input", "change"] {
            sync_dispatch::emit_full(window, cx, &self.callback, control, event_type, |payload| {
                payload.target = Some(control as f64);
                payload.path = Some(path.iter().map(|id| *id as f64).collect());
            });
        }
        self.tree.lock().unwrap().restore_controlled(control);
        self.invalidate(window, cx);
    }

    /// Delivers `click`, which native made, with the activation behaviour around it: the toggle of a
    /// checkbox or radio before the listeners, and what follows it after, unless a handler
    /// canceled the click.
    pub(crate) fn deliver_click(&self, click: EventPayload, window: &mut Window, cx: &mut App) -> sync_dispatch::DispatchOutcome {
        let control = self.pre_activate(&click, window, cx);
        let outcome = sync_dispatch::emit(window, cx, &self.callback, click.clone());
        if outcome.default_prevented {
            if let Some(control) = control {
                self.cancel_choice(control, window, cx);
            }
        } else {
            self.activate(&click, window, cx);
        }
        outcome
    }

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
        let toggled = self.pre_activate(&payload, window, cx);
        let outcome = sync_dispatch::emit(window, cx, &self.callback, payload.clone());
        let path: Vec<u64> = payload.path.iter().flatten().map(|id| *id as u64).collect();
        if outcome.default_prevented {
            if let Some(control) = toggled {
                self.cancel_choice(control, window, cx);
            }
            return;
        }
        // Not `activate`: a control that is no activation target (a text field) would hand the click
        // back to this label.
        let target = {
            let tree = self.tree.lock().unwrap();
            crate::html::activation_target(&tree, &path).and_then(|id| Some((id, tree.elements.get(&id)?.element_type.clone())))
        };
        match target {
            Some((_, element_type)) if element_type == "button" => crate::forms::button_clicked(&self.tree, &path, window, cx),
            Some((id, element_type)) if element_type == "input" => self.choice_activated(id, window, cx),
            _ => {}
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
                .map(|element| (element.id, element.element_type.clone()))
        };
        match target {
            Some((_, element_type)) if element_type == "label" => self.activate_label(click, window, cx),
            Some((_, element_type)) if element_type == "button" => crate::forms::button_clicked(&self.tree, &path, window, cx),
            Some((id, element_type)) if element_type == "input" => self.choice_activated(id, window, cx),
            _ => {}
        }
    }

    /// Delivers a click that no pointer made and then runs its activation
    /// behaviour, as `HTMLElement.click()` does. A handler that cancels the
    /// click keeps its activation from running, where the outcome is
    /// known (see `sync_dispatch::emit`).
    pub(crate) fn click(&self, click: EventPayload, window: &mut Window, cx: &mut App) {
        self.deliver_click(click, window, cx);
    }

    /// The activation behaviour of a click an app dispatched at the element `id` with
    /// `dispatchEvent`, which JS has already delivered and no listener cancelled: that of the
    /// activation target on the element's path. Does nothing for a disabled form control.
    pub(crate) fn activate_element(&self, id: u64, window: &mut Window, cx: &mut App) -> Result<(), String> {
        let click = {
            let tree = self.tree.lock().unwrap();
            synthetic_click::click_element(&tree, id)?
        };
        if let Some(click) = click {
            self.activate(&click, window, cx);
        }
        Ok(())
    }

    /// The click an app dispatches at the element `id`, which JS is about to deliver: the toggle of
    /// the checkbox or radio it activates, so that its listeners see the new state.
    pub(crate) fn pre_activate_element(&self, id: u64, window: &mut Window, cx: &mut App) -> Result<(), String> {
        let click = {
            let tree = self.tree.lock().unwrap();
            synthetic_click::click_element(&tree, id)?
        };
        if let Some(click) = click {
            self.pre_activate(&click, window, cx);
        }
        Ok(())
    }

    /// The dispatched click at `id` was canceled: the checkbox or radio it toggled is as it was.
    pub(crate) fn cancel_element(&self, id: u64, window: &mut Window, cx: &mut App) -> Result<(), String> {
        let control = {
            let tree = self.tree.lock().unwrap();
            let Some(click) = synthetic_click::click_element(&tree, id)? else {
                return Ok(());
            };
            let path: Vec<u64> = click.path.iter().flatten().map(|id| *id as u64).collect();
            crate::html::activation_target(&tree, &path)
        };
        if let Some(control) = control {
            self.cancel_choice(control, window, cx);
        }
        Ok(())
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

/// `Activation::activate_element` for the window's root view. Like `click_element_with`, it reads the
/// view for its shared state, and runs once the view is free when something else holds it.
pub(crate) fn activate_element(id: u64, window: &mut Window, cx: &mut App) -> Result<(), String> {
    let view = window
        .root::<GpuixView>()
        .flatten()
        .ok_or_else(|| "The window has no GpuixView".to_string())?;
    if view.is_updating(cx) {
        window.defer(cx, move |window, cx| {
            if let Err(error) = activate_element(id, window, cx) {
                sync_dispatch::report_deferred_error(error);
            }
        });
        return Ok(());
    }
    let activation = view.read(cx).activation();
    activation.activate_element(id, window, cx)
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

/// The window's activation for a call that must see the view as it is: it cannot wait for the input
/// being dispatched to release the view.
fn current_activation(window: &Window, cx: &App) -> Result<Activation, String> {
    let view = sync_dispatch::root_view(window)?;
    if view.is_updating(cx) {
        return Err(sync_dispatch::VIEW_BUSY.to_string());
    }
    Ok(view.read(cx).activation())
}

/// `Activation::pre_activate_element` for the window's root view.
pub(crate) fn pre_activate_element(id: u64, window: &mut Window, cx: &mut App) -> Result<(), String> {
    current_activation(window, cx)?.pre_activate_element(id, window, cx)
}

/// `Activation::cancel_element` for the window's root view.
pub(crate) fn cancel_element(id: u64, window: &mut Window, cx: &mut App) -> Result<(), String> {
    current_activation(window, cx)?.cancel_element(id, window, cx)
}
