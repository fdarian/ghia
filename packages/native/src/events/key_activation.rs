//! The keys that click a focused element, as a browser does: Enter on a `<button>` or an `<a href>`
//! (on key down), and Space on a `<button>` (on key up). Which tags take which key, and how, is
//! `html::activation_keys`.
//!
//! Enter repeats on a button while it is held and clicks a link once per press. A link takes Enter
//! with Ctrl, Alt or Cmd held and its click carries them; a button takes none of those.
//!
//! Space needs the whole press: the key down arms the button, which is `:active` until the press
//! ends, and the key up clicks it only when that button is still the focused element. A `keydown` a
//! handler cancelled arms nothing, and a `keyup` a handler cancelled clicks nothing. Every Space key
//! down ends the press before it, and so does the armed element losing focus. A Space with a ctrl,
//! alt or cmd modifier is not an activation.
//!
//! The click goes through `activation::click_element`, so it is a DOM click that bubbles with
//! `detail` 0 and then runs the activation behaviour (a button submits its form). Nothing navigates
//! for an `<a>`: Ghia has no navigation.

use std::cell::RefCell;

use gpui::{App, Keystroke, Window};

use crate::element_tree::EventModifiers;
use crate::retained_tree::RetainedTree;

use super::activation::{self, Activation};
use super::keyboard::{redraw_for_focus_visible, InputRouting};
use super::path::event_path;
use super::state::PointerState;
use super::sync_dispatch;

fn is_plain(keystroke: &Keystroke) -> bool {
    let modifiers = keystroke.modifiers;
    !(modifiers.control || modifiers.alt || modifiers.platform)
}

/// The focused element and the keys that click it, when it is one that a key clicks.
fn focused_activation(
    activation: &Activation,
    window: &Window,
    cx: &App,
) -> Option<(u64, crate::html::ActivationKeys)> {
    let focused = activation.routing.focused_element(window, cx)?;
    let tree = activation.tree.lock().unwrap();
    let keys = crate::html::activation_keys(tree.elements.get(&focused)?)?;
    Some((focused, keys))
}

fn click(id: u64, modifiers: EventModifiers, window: &mut Window, cx: &mut App) {
    if let Err(error) = activation::click_element_with(id, Some(modifiers), window, cx) {
        sync_dispatch::report_deferred_error(error);
    }
}

/// Ends the Space press under way, if there is one: the arm goes, and so does the `:active` it set
/// on the element, unless a pointer press has taken the chain since. Returns the element that was
/// armed and whether clearing `:active` restyled.
fn end_space_press(
    routing: &InputRouting,
    pointer: &RefCell<PointerState>,
    tree: &RetainedTree,
) -> (Option<u64>, bool) {
    let Some(armed) = routing.take_armed_space() else {
        return (None, false);
    };
    let mut pointer = pointer.borrow_mut();
    let restyle = pointer.chains().1.first() == Some(&armed) && super::dispatcher::set_active(&mut pointer, tree, Vec::new());
    (Some(armed), restyle)
}

/// The armed element lost focus: its Space press is over, whatever key comes next.
pub(crate) fn blurred(routing: &InputRouting, pointer: &RefCell<PointerState>, tree: &RetainedTree, element: u64) {
    if routing.armed_space() == Some(element) {
        end_space_press(routing, pointer, tree);
    }
}

/// A `keydown`; `prevented` is whether a handler cancelled it.
pub(crate) fn key_down(
    activation: &Activation,
    keystroke: &Keystroke,
    is_held: bool,
    prevented: bool,
    window: &mut Window,
    cx: &mut App,
) {
    let is_space = keystroke.key == "space";
    let is_enter = keystroke.key == "enter";
    if !is_space && !is_enter {
        return;
    }
    // Space down always ends the press before it, so a cancelled one cannot leave a stale arm.
    let mut restyle = false;
    if is_space {
        let tree = activation.tree.lock().unwrap();
        restyle = end_space_press(&activation.routing, &activation.pointer, &tree).1;
    }
    if !prevented {
        if let Some((id, keys)) = focused_activation(activation, window, cx) {
            if is_enter && keys.enter && (!is_held || keys.enter_repeats) && (is_plain(keystroke) || keys.enter_with_modifiers) {
                click(id, EventModifiers::from(keystroke.modifiers), window, cx);
            } else if is_space && keys.space && is_plain(keystroke) {
                let tree = activation.tree.lock().unwrap();
                activation.routing.arm_space(id);
                restyle |= super::dispatcher::set_active(&mut activation.pointer.borrow_mut(), &tree, event_path(&tree, id));
            }
        }
    }
    if restyle {
        redraw_for_focus_visible(window, cx);
    }
}

/// A `keyup`; `prevented` is whether a handler cancelled it.
pub(crate) fn key_up(
    activation: &Activation,
    keystroke: &Keystroke,
    prevented: bool,
    window: &mut Window,
    cx: &mut App,
) {
    if keystroke.key != "space" {
        return;
    }
    let (armed, restyle) = {
        let tree = activation.tree.lock().unwrap();
        end_space_press(&activation.routing, &activation.pointer, &tree)
    };
    if restyle {
        redraw_for_focus_visible(window, cx);
    }
    let Some(armed) = armed else {
        return;
    };
    if prevented || !is_plain(keystroke) {
        return;
    }
    if focused_activation(activation, window, cx).is_some_and(|(id, keys)| id == armed && keys.space) {
        click(armed, EventModifiers::from(keystroke.modifiers), window, cx);
    }
}
