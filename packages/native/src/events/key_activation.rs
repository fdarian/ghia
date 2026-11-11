//! The keys that click a focused element, as a browser does: Enter on a `<button>` or an `<a href>`
//! (on key down, repeating while held), and Space on a `<button>` (on key up).
//!
//! Space needs the whole press: the key down arms the button and the key up clicks it only when
//! that button is still the focused element. A `keydown` a handler cancelled arms nothing, and a
//! `keyup` a handler cancelled clicks nothing. A key with a ctrl, alt or cmd modifier is not an
//! activation. Which tags take which key is `html::activation_keys`.
//!
//! The click goes through `activation::click_element`, so it is a DOM click that bubbles with
//! `detail` 0 and then runs the activation behaviour (a button submits its form). Nothing navigates
//! for an `<a>`: Ghia has no navigation.

use gpui::{App, Keystroke, Window};

use super::activation::{self, Activation};
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

fn click(id: u64, window: &mut Window, cx: &mut App) {
    if let Err(error) = activation::click_element(id, window, cx) {
        sync_dispatch::report_deferred_error(error);
    }
}

/// A `keydown` that no handler cancelled.
pub(crate) fn key_down(activation: &Activation, keystroke: &Keystroke, window: &mut Window, cx: &mut App) {
    if !is_plain(keystroke) || !matches!(keystroke.key.as_str(), "enter" | "space") {
        return;
    }
    let Some((id, keys)) = focused_activation(activation, window, cx) else {
        return;
    };
    match keystroke.key.as_str() {
        "enter" if keys.enter => click(id, window, cx),
        "space" if keys.space => activation.routing.arm_space(id),
        _ => {}
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
    let Some(armed) = activation.routing.take_armed_space() else {
        return;
    };
    if prevented || !is_plain(keystroke) {
        return;
    }
    if focused_activation(activation, window, cx).is_some_and(|(id, keys)| id == armed && keys.space) {
        click(armed, window, cx);
    }
}
