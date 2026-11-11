//! The `<form>` element: which controls belong to it, validation, and
//! submission.
//!
//! A control belongs to its nearest `form` ancestor. Submission validates first:
//! every `required` control with an empty value gets a non-bubbling `invalid`
//! event, and the first one no handler cancelled takes focus. When nothing is
//! invalid the form gets a cancelable, bubbling `submit` event carrying the
//! `[name, value]` entries of its named, enabled controls in document order.
//!
//! A `<button>` in a form whose `type` is missing or `submit` submits it when
//! clicked, and its element is the event's `submitter`. `type="button"` does
//! nothing. `type="reset"` does nothing either: gpuix does not reset controls.
//!
//! Enter in an `<input>` submits its form by HTML's implicit submission rule:
//! when the form has a submit button, the first one is the default button and
//! gets a `click` (nothing happens if it is disabled); when it has none, only
//! if at most one field blocks implicit submission.
//!
//! Both events are sent with `sync_dispatch::emit`, with the root view released:
//! a handler is free to call back into the renderer.

use gpui::{App, Window};

use crate::element_tree::EventPayload;
use crate::events::keyboard::path_to_root;
use crate::events::sync_dispatch;
use crate::focus::is_text_control;
use crate::renderer::{EventCallback, GpuixView};
use crate::retained_tree::RetainedTree;

/// The nearest `form` above `control`, not counting `control` itself.
pub(crate) fn enclosing_form(tree: &RetainedTree, control: u64) -> Option<u64> {
    path_to_root(tree, control)
        .into_iter()
        .skip(1)
        .find(|id| is_form(tree, *id))
}

fn is_form(tree: &RetainedTree, id: u64) -> bool {
    tree.elements
        .get(&id)
        .is_some_and(|element| element.element_type == "form")
}

/// The controls that belong to `form`, in document order. A nested form's
/// controls belong to that form.
fn controls_of(tree: &RetainedTree, form: u64) -> Vec<u64> {
    members_of(tree, form, |element| is_text_control(&element.element_type))
}

/// The submit buttons of `form`, in document order.
fn submit_buttons_of(tree: &RetainedTree, form: u64) -> Vec<u64> {
    members_of(tree, form, |element| {
        element.element_type == "button" && crate::html::button_type(element) == crate::html::ButtonType::Submit
    })
}

/// The elements below `form` that `keep` accepts, in document order, leaving out those of a nested form.
fn members_of(tree: &RetainedTree, form: u64, keep: impl Fn(&crate::retained_tree::RetainedElement) -> bool) -> Vec<u64> {
    let mut controls = Vec::new();
    let mut pending: Vec<u64> = tree
        .elements
        .get(&form)
        .map(|element| element.children.iter().rev().copied().collect())
        .unwrap_or_default();
    while let Some(id) = pending.pop() {
        let Some(element) = tree.elements.get(&id) else {
            continue;
        };
        if element.element_type == "form" {
            continue;
        }
        if keep(element) {
            controls.push(id);
        }
        pending.extend(element.children.iter().rev().copied());
    }
    controls
}

struct Control {
    id: u64,
    path: Vec<u64>,
    name: Option<String>,
    value: String,
    required: bool,
    disabled: bool,
    read_only: bool,
}

impl Control {
    /// Disabled and read-only controls are barred from constraint validation.
    fn is_invalid(&self) -> bool {
        self.required && self.value.is_empty() && !self.disabled && !self.read_only
    }

    /// `[name, value]`, for a control that has a name and is not disabled.
    fn entry(&self) -> Option<Vec<String>> {
        let name = self.name.as_ref().filter(|name| !name.is_empty())?;
        (!self.disabled).then(|| vec![name.clone(), self.value.clone()])
    }
}

struct FormRead {
    callback: Option<EventCallback>,
    path: Vec<u64>,
    controls: Vec<Control>,
}

impl GpuixView {
    fn read_form(&mut self, form: u64, cx: &mut gpui::Context<Self>) -> Result<FormRead, String> {
        let (path, members) = {
            let tree = self.tree.lock().unwrap();
            if !is_form(&tree, form) {
                return Err(format!("Element {form} is not a <form>"));
            }
            let members: Vec<_> = controls_of(&tree, form)
                .into_iter()
                .filter_map(|id| {
                    let element = tree.elements.get(&id)?;
                    Some((
                        id,
                        element.element_type.clone(),
                        element.custom_props().clone(),
                        path_to_root(&tree, id),
                    ))
                })
                .collect();
            (path_to_root(&tree, form), members)
        };

        let mut controls = Vec::with_capacity(members.len());
        for (id, element_type, props, control_path) in members {
            let value = self
                .custom_registry
                .with_element(id, &element_type, &props, |element| element.text_value(cx))
                .flatten()
                .ok_or_else(|| format!("Element {id} has no text value"))?;
            let flag = |key: &str| props.get(key).and_then(|value| value.as_bool()) == Some(true);
            controls.push(Control {
                id,
                path: control_path,
                name: props.get("name").and_then(|name| name.as_str()).map(str::to_string),
                value,
                required: flag("required"),
                disabled: flag("disabled"),
                read_only: flag("readOnly"),
            });
        }
        Ok(FormRead {
            callback: self.event_callback.clone(),
            path,
            controls,
        })
    }
}

fn path_payload(payload: &mut EventPayload, path: &[u64]) {
    payload.target = Some(path[0] as f64);
    payload.path = Some(path.iter().map(|id| *id as f64).collect());
}

/// What a refusal starts with when the DOM would throw a `TypeError` or a `NotFoundError`, which JS turns into one.
pub(crate) const TYPE_ERROR: &str = "TypeError: ";
pub(crate) const NOT_FOUND_ERROR: &str = "NotFoundError: ";

/// What `form.requestSubmit(submitter)` requires of `submitter`: a submit button of `form`.
fn check_submitter(tree: &RetainedTree, form: u64, submitter: u64) -> Result<(), String> {
    let is_submit_button = tree.elements.get(&submitter).is_some_and(|element| {
        element.element_type == "button" && crate::html::button_type(element) == crate::html::ButtonType::Submit
    });
    if !is_submit_button {
        return Err(format!("{TYPE_ERROR}The specified element is not a submit button"));
    }
    if enclosing_form(tree, submitter) != Some(form) {
        return Err(format!("{NOT_FOUND_ERROR}The specified element is not owned by this form element"));
    }
    Ok(())
}

/// `form.requestSubmit()`: validate, then submit. `submitter` is the button that asked, if one did.
pub(crate) fn request_submit(window: &mut Window, cx: &mut App, form: u64, submitter: Option<u64>) -> Result<(), String> {
    let view = window
        .root::<GpuixView>()
        .flatten()
        .ok_or_else(|| "The window has no GpuixView".to_string())?;
    if view.is_updating(cx) {
        return Err(sync_dispatch::VIEW_BUSY.to_string());
    }
    if let Some(submitter) = submitter {
        check_submitter(&view.read(cx).tree.lock().unwrap(), form, submitter)?;
    }
    let read = view.update(cx, |view, cx| view.read_form(form, cx))?;

    let mut first_unhandled = None;
    for control in read.controls.iter().filter(|control| control.is_invalid()) {
        let outcome = sync_dispatch::emit_full(
            window,
            cx,
            &read.callback,
            control.id,
            "invalid",
            |payload| path_payload(payload, &control.path),
        );
        if !outcome.default_prevented && first_unhandled.is_none() {
            first_unhandled = Some(control.id);
        }
    }
    if read.controls.iter().any(Control::is_invalid) {
        if let Some(id) = first_unhandled {
            if view.is_updating(cx) {
                return Err(sync_dispatch::VIEW_BUSY.to_string());
            }
            crate::focus::change_focus(window, cx, move |view, window, cx| {
                view.request_focus(id, window, cx)
            })?;
        }
        return Ok(());
    }

    let entries: Vec<Vec<String>> = read.controls.iter().filter_map(Control::entry).collect();
    sync_dispatch::emit_full(window, cx, &read.callback, form, "submit", |payload| {
        path_payload(payload, &read.path);
        payload.form_entries = Some(entries);
        payload.submitter_id = submitter.map(|id| id as f64);
    });
    Ok(())
}

/// What Enter in a text field does to `form`.
#[derive(Debug, PartialEq, Eq)]
enum ImplicitSubmission {
    /// Click the default button, which submits as a click on it does.
    Click(u64),
    Submit,
}

/// What Enter in a text field of `form` does, by HTML's implicit submission rule. The first submit
/// button is the default button: it is clicked, or nothing happens when it is disabled. A form
/// with none submits only when at most one field blocks implicit submission. Every `<input>`
/// blocks it, whatever its `type`, `disabled` or `readOnly`; a `<textarea>` does not.
fn implicit_submission_of(tree: &RetainedTree, form: u64) -> Option<ImplicitSubmission> {
    if let Some(default_button) = submit_buttons_of(tree, form).first().and_then(|id| tree.elements.get(id)) {
        return (!default_button.is_disabled()).then_some(ImplicitSubmission::Click(default_button.id));
    }
    let blocking = controls_of(tree, form)
        .into_iter()
        .filter(|id| tree.elements.get(id).is_some_and(|element| element.element_type == "input"))
        .count();
    (blocking <= 1).then_some(ImplicitSubmission::Submit)
}

/// Enter in an `<input>`: submit its form, if it has one and the rule above allows it. Runs once the
/// key dispatch is over, so the form is read after the keydown handlers have changed it.
pub(crate) fn implicit_submission(
    view: gpui::WeakEntity<GpuixView>,
    control: u64,
    window: &mut Window,
    cx: &mut App,
) {
    window.defer(cx, move |window, cx| {
        let Some(view) = view.upgrade() else {
            return;
        };
        let submission = {
            let tree = view.read(cx).tree.lock().unwrap();
            enclosing_form(&tree, control).and_then(|form| implicit_submission_of(&tree, form).map(|what| (form, what)))
        };
        let result = match submission {
            None => return,
            Some((form, ImplicitSubmission::Submit)) => request_submit(window, cx, form, None),
            Some((_, ImplicitSubmission::Click(button))) => crate::events::activation::click_element(button, window, cx),
        };
        if let Err(error) = result {
            log::error!("Implicit submission from element {control} failed: {error}");
        }
    });
}

/// The default action of a `click` no handler cancelled, on `path` (innermost first): the nearest
/// `button` on it submits its form when its `type` says so. Runs once the click is over, so the form
/// is read after the click handlers have changed it.
pub(crate) fn button_clicked(tree: &std::sync::Mutex<RetainedTree>, path: &[u64], window: &mut Window, cx: &mut App) {
    let Some((form, button)) = submission_by_click(&tree.lock().unwrap(), path) else {
        return;
    };
    window.defer(cx, move |window, cx| {
        if let Err(error) = request_submit(window, cx, form, Some(button)) {
            log::error!("Submitting form {form} from button {button} failed: {error}");
        }
    });
}

/// The form a click on `path` submits and the button that does it: the button is the activation
/// target, the first element on the path with an activation behaviour (a link or a label inside it
/// takes the click for itself), when its `type` is `submit` and it is inside a form. A click has to
/// be delivered for it even with no listener, since the submission is decided after the event ran.
pub(crate) fn submission_by_click(tree: &RetainedTree, path: &[u64]) -> Option<(u64, u64)> {
    let button = tree.elements.get(&crate::html::activation_target(tree, path)?)?;
    (button.element_type == "button"
        && crate::html::button_type(button) == crate::html::ButtonType::Submit
        && !button.is_disabled())
    .then(|| enclosing_form(tree, button.id).map(|form| (form, button.id)))
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree_of(elements: &[(u64, &str)], edges: &[(u64, u64)]) -> RetainedTree {
        let mut tree = RetainedTree::new();
        for (id, element_type) in elements {
            tree.create_element(*id, element_type.to_string());
        }
        for (parent, child) in edges {
            tree.append_child(*parent, *child);
        }
        tree
    }

    #[test]
    fn a_control_belongs_to_its_nearest_form() {
        let tree = tree_of(
            &[(1, "form"), (2, "div"), (3, "form"), (4, "input"), (5, "input")],
            &[(1, 2), (2, 3), (3, 4), (2, 5)],
        );
        assert_eq!(enclosing_form(&tree, 4), Some(3));
        assert_eq!(enclosing_form(&tree, 5), Some(1));
        assert_eq!(enclosing_form(&tree, 1), None);
    }

    #[test]
    fn controls_come_in_document_order_without_a_nested_forms_controls() {
        let tree = tree_of(
            &[
                (1, "form"),
                (2, "input"),
                (3, "div"),
                (4, "textarea"),
                (5, "form"),
                (6, "input"),
                (7, "input"),
            ],
            &[(1, 2), (1, 3), (3, 4), (1, 5), (5, 6), (1, 7)],
        );
        assert_eq!(controls_of(&tree, 1), vec![2, 4, 7]);
        assert_eq!(controls_of(&tree, 5), vec![6]);
    }

    #[test]
    fn without_a_submit_button_enter_submits_only_a_form_with_at_most_one_input() {
        let one = tree_of(
            &[(1, "form"), (2, "input"), (3, "textarea"), (4, "form"), (5, "input")],
            &[(1, 2), (1, 3), (1, 4), (4, 5)],
        );
        assert_eq!(implicit_submission_of(&one, 1), Some(ImplicitSubmission::Submit));
        let two = tree_of(
            &[(1, "form"), (2, "input"), (3, "div"), (4, "input")],
            &[(1, 2), (1, 3), (3, 4)],
        );
        assert_eq!(implicit_submission_of(&two, 1), None);
        let none = tree_of(&[(1, "form"), (2, "textarea")], &[(1, 2)]);
        assert_eq!(implicit_submission_of(&none, 1), Some(ImplicitSubmission::Submit));
    }

    fn typed_button(tree: &mut RetainedTree, id: u64, button_type: Option<&str>, disabled: bool) {
        if let Some(button_type) = button_type {
            tree.set_custom_prop(id, "type".to_string(), serde_json::json!(button_type));
        }
        if disabled {
            tree.set_custom_prop(id, "disabled".to_string(), serde_json::json!(true));
        }
    }

    #[test]
    fn the_first_submit_button_is_the_default_button_and_two_inputs_do_not_matter() {
        let mut tree = tree_of(
            &[(1, "form"), (2, "input"), (3, "input"), (4, "button"), (5, "button"), (6, "button")],
            &[(1, 2), (1, 3), (1, 4), (1, 5), (1, 6)],
        );
        typed_button(&mut tree, 4, Some("button"), false);
        typed_button(&mut tree, 5, Some("bogus"), false);
        assert_eq!(submit_buttons_of(&tree, 1), vec![5, 6]);
        assert_eq!(implicit_submission_of(&tree, 1), Some(ImplicitSubmission::Click(5)));
    }

    #[test]
    fn a_disabled_default_button_leaves_enter_with_nothing_to_do() {
        let mut tree = tree_of(&[(1, "form"), (2, "input"), (3, "button"), (4, "button")], &[(1, 2), (1, 3), (1, 4)]);
        typed_button(&mut tree, 3, None, true);
        assert_eq!(implicit_submission_of(&tree, 1), None);
    }

    #[test]
    fn a_form_of_buttons_that_do_not_submit_falls_back_to_the_field_count() {
        let mut tree = tree_of(&[(1, "form"), (2, "input"), (3, "button")], &[(1, 2), (1, 3)]);
        typed_button(&mut tree, 3, Some("reset"), false);
        assert_eq!(implicit_submission_of(&tree, 1), Some(ImplicitSubmission::Submit));
    }

    #[test]
    fn the_buttons_of_a_nested_form_are_its_own() {
        let tree = tree_of(
            &[(1, "form"), (2, "form"), (3, "button"), (4, "div"), (5, "button")],
            &[(1, 2), (2, 3), (1, 4), (4, 5)],
        );
        assert_eq!(submit_buttons_of(&tree, 1), vec![5]);
        assert_eq!(submit_buttons_of(&tree, 2), vec![3]);
    }

    #[test]
    fn a_submitter_is_a_submit_button_of_the_form() {
        let mut tree = tree_of(
            &[(1, "form"), (2, "button"), (3, "button"), (4, "div"), (5, "form"), (6, "button"), (7, "button"), (8, "button")],
            &[(1, 2), (1, 3), (1, 4), (1, 5), (5, 6), (1, 7), (1, 8)],
        );
        typed_button(&mut tree, 3, Some("button"), false);
        typed_button(&mut tree, 7, Some("reset"), false);
        assert_eq!(check_submitter(&tree, 1, 2), Ok(()));
        typed_button(&mut tree, 8, Some("submit"), true);
        assert_eq!(check_submitter(&tree, 1, 8), Ok(()), "a disabled button is still a submitter");
        for not_a_submit_button in [3, 4, 7, 99] {
            assert!(check_submitter(&tree, 1, not_a_submit_button).unwrap_err().starts_with(TYPE_ERROR), "{not_a_submit_button}");
        }
        assert!(check_submitter(&tree, 1, 6).unwrap_err().starts_with(NOT_FOUND_ERROR), "a button of a nested form");
        assert!(check_submitter(&tree, 5, 2).unwrap_err().starts_with(NOT_FOUND_ERROR), "a button of the outer form");
        assert_eq!(check_submitter(&tree, 5, 6), Ok(()));
    }

    fn control(name: Option<&str>, value: &str) -> Control {
        Control {
            id: 1,
            path: vec![1],
            name: name.map(str::to_string),
            value: value.to_string(),
            required: false,
            disabled: false,
            read_only: false,
        }
    }

    #[test]
    fn only_named_enabled_controls_make_entries() {
        assert_eq!(
            control(Some("a"), "x").entry(),
            Some(vec!["a".to_string(), "x".to_string()])
        );
        assert_eq!(control(None, "x").entry(), None);
        assert_eq!(control(Some(""), "x").entry(), None);
        let mut disabled = control(Some("a"), "x");
        disabled.disabled = true;
        assert_eq!(disabled.entry(), None);
    }

    #[test]
    fn required_empty_controls_are_invalid_unless_barred() {
        let mut required = control(Some("a"), "");
        required.required = true;
        assert!(required.is_invalid());
        required.value = "x".to_string();
        assert!(!required.is_invalid());
        required.value.clear();
        required.read_only = true;
        assert!(!required.is_invalid());
        required.read_only = false;
        required.disabled = true;
        assert!(!required.is_invalid());
    }

    #[test]
    fn a_click_submits_only_when_the_button_is_the_first_activation_target_on_the_path() {
        let mut tree = RetainedTree::new();
        crate::batch::test_json::apply(
            &mut tree,
            r#"[["createElement",1,"form"],["setRoot",1],
                ["createElement",2,"button"],["appendChild",1,2],
                ["createElement",3,"a"],["appendChild",2,3],["setCustomProp",3,"href","/x"],
                ["createElement",4,"label"],["appendChild",2,4],
                ["createElement",5,"span"],["appendChild",2,5],
                ["createElement",6,"a"],["appendChild",2,6]]"#,
        )
        .unwrap();
        assert_eq!(submission_by_click(&tree, &[2, 1]), Some((1, 2)));
        assert_eq!(submission_by_click(&tree, &[5, 2, 1]), Some((1, 2)));
        assert_eq!(submission_by_click(&tree, &[6, 2, 1]), Some((1, 2)), "an a without an href has no behaviour");
        assert_eq!(submission_by_click(&tree, &[3, 2, 1]), None, "the link is the target");
        assert_eq!(submission_by_click(&tree, &[4, 2, 1]), None, "the label is the target");
    }
}
