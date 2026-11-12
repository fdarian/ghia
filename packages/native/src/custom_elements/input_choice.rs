//! `<input type="checkbox">`, `<input type="radio">` and `<input type="hidden">`.
//!
//! `<input>` is one custom element whose `type` picks what it builds (`InputElement`): the text
//! editor for a text-like type, a choice control for `checkbox` and `radio`, nothing for `hidden`
//! and the slider of `input_range` for `range`.
//! A runtime change of `type` switches the control and replays the props it was given.
//!
//! A choice control is a box with Chrome's default size and nothing painted in it (see
//! `docs/fork/deviations.md`). What it carries is its state, which HTML splits in four: the
//! checkedness, the dirty flag (a user or script write to the checkedness stops `defaultChecked`
//! from setting it), `indeterminate`, and a `value` that defaults to `"on"`. The state lives in the
//! retained tree (`Choices`), where the activation, `FormData`, the accessibility node and
//! the JS properties all read it without leasing the view.
//!
//! Activation follows the HTML algorithm. Before the click's listeners run, the control is toggled
//! (`pre_activate`, legacy-pre-activation): a click handler sees the new `checked`. A canceled
//! click puts the previous state back (`cancel_activation`, legacy-canceled-activation); otherwise
//! `input` and then `change` fire (`finish_activation`). A radio unchecks the others of its group:
//! the same non-empty `name`, in the same form, or in the same tree when it has no form.

use std::collections::HashMap;

use gpui::accesskit::Toggled;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use napi_derive::napi;
use gpui::prelude::*;
use rustc_hash::FxHashMap;
use serde_json::Value;

use super::input_rules::InputType;
use super::{CustomElement, CustomRenderContext};
use crate::retained_tree::{RetainedElement, RetainedTree};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Choice {
    Checkbox,
    Radio,
}

/// The `type` an `<input>` has as its props say.
pub(crate) fn input_type(props: &HashMap<String, Value>) -> InputType {
    InputType::parse(props.get("type").and_then(Value::as_str).unwrap_or_default())
}

/// The kind of choice control the element is, if it is a checkbox or a radio.
pub(crate) fn choice_of(element: &RetainedElement) -> Option<Choice> {
    if element.element_type != "input" {
        return None;
    }
    match input_type(element.custom_props()) {
        InputType::Checkbox => Some(Choice::Checkbox),
        InputType::Radio => Some(Choice::Radio),
        _ => None,
    }
}

/// Whether a click on `path` (innermost first) activates an enabled checkbox or radio: its activation
/// target is one. The click has to be delivered for it even with no listener, since the toggle is
/// made before the listeners and what follows it after.
pub(crate) fn is_activated_by(tree: &RetainedTree, path: &[u64]) -> bool {
    crate::html::activation_target(tree, path).is_some_and(|target| {
        tree.elements.get(&target).and_then(choice_of).is_some() && !tree.in_disabled_form_control(target) && !tree.is_inert(target)
    })
}

/// An `<input type="hidden">`: it builds no box and cannot be focused.
pub(crate) fn is_hidden(element: &RetainedElement) -> bool {
    element.element_type == "input" && input_type(element.custom_props()) == InputType::Hidden
}

/// A text field that implicit submission counts: every `<input>` but a checkbox, a radio and a
/// hidden one.
pub(crate) fn blocks_implicit_submission(element: &RetainedElement) -> bool {
    element.element_type == "input" && input_type(element.custom_props()).edits_text()
}

/// An element the text editor builds: a `<textarea>`, or an `<input>` of a text-like type.
pub(crate) fn is_text_editor(element: &RetainedElement) -> bool {
    match element.element_type.as_str() {
        "textarea" => true,
        "input" => input_type(element.custom_props()).edits_text(),
        _ => false,
    }
}

/// The `value` of a checkbox, radio or hidden input: the attribute as text, `"on"` by default for
/// a choice and empty for a hidden input.
pub(crate) fn value_of(element: &RetainedElement) -> String {
    let value = match element.custom_props().get("value") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => None,
    };
    value.unwrap_or_else(|| if choice_of(element).is_some() { "on".to_string() } else { String::new() })
}

/// The toggled state a choice control reports to assistive technology: `mixed` for an
/// indeterminate checkbox.
pub(crate) fn toggled_of(tree: &RetainedTree, element: &RetainedElement) -> Option<Toggled> {
    let choice = choice_of(element)?;
    Some(if choice == Choice::Checkbox && tree.is_indeterminate(element.id) {
        Toggled::Mixed
    } else if tree.is_checked(element.id) {
        Toggled::True
    } else {
        Toggled::False
    })
}

/// What the `checked`, `defaultChecked`, `indeterminate` and `value` properties of an `<input>` read.
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
pub struct InputChoiceState {
    /// `"checkbox"`, `"radio"`, `"hidden"`, `"range"` or `"text"`, which covers every other type.
    pub kind: String,
    pub checked: bool,
    pub default_checked: bool,
    pub indeterminate: bool,
    /// The `value` attribute of a checkbox, radio or hidden input, with its default, and the
    /// sanitized value of a range. Empty for a text field, whose value is its text (`getTextValue`).
    pub value: String,
    /// A range's limits and step, which `min`, `max` and `step` default and sanitize; 0 for another
    /// type. A `step` of 0 is `step="any"`.
    pub min: f64,
    pub max: f64,
    pub step: f64,
}

/// The state of the `<input>` `id`, as the JS properties read it.
pub(crate) fn read(tree: &RetainedTree, id: u64) -> Result<InputChoiceState, String> {
    let element = tree.elements.get(&id).ok_or_else(|| format!("Unknown element id {id}"))?;
    if element.element_type != "input" {
        return Err(format!("Element {id} is a <{}>, not an <input>", element.element_type));
    }
    let kind = match input_type(element.custom_props()) {
        InputType::Checkbox => "checkbox",
        InputType::Radio => "radio",
        InputType::Hidden => "hidden",
        InputType::Range => "range",
        _ => "text",
    };
    let range = super::input_range::reading_of(tree, element);
    Ok(InputChoiceState {
        kind: kind.to_string(),
        checked: tree.is_checked(id),
        default_checked: tree.default_checked(id),
        indeterminate: tree.is_indeterminate(id),
        value: match (kind, range) {
            ("text", _) => String::new(),
            (_, Some(range)) => range.text(),
            _ => value_of(element),
        },
        min: range.map_or(0.0, |range| range.rules.min),
        max: range.map_or(0.0, |range| range.rules.max),
        step: range.map_or(0.0, |range| range.rules.step.unwrap_or(0.0)),
    })
}

#[derive(Default)]
struct State {
    checked: bool,
    default_checked: bool,
    dirty: bool,
    indeterminate: bool,
}

/// What a pre-activation changed, for a canceled click to put back.
struct Undo {
    checked: bool,
    indeterminate: bool,
    dirty: bool,
    /// The radio of the group that was checked, and the click unchecked.
    unchecked: Option<u64>,
}

/// The state of every `<input>` of a tree, and the activations that have begun and not ended (a
/// stack per element, since a click handler may click the control again).
#[derive(Default)]
pub(crate) struct Choices {
    states: FxHashMap<u64, State>,
    pending: FxHashMap<u64, Vec<Undo>>,
}

impl Choices {
    pub(crate) fn created(&mut self, id: u64) {
        self.states.insert(id, State::default());
    }

    pub(crate) fn destroyed(&mut self, id: u64) {
        self.states.remove(&id);
        self.pending.remove(&id);
    }
}

impl RetainedTree {
    pub(crate) fn is_checked(&self, id: u64) -> bool {
        self.choices.states.get(&id).is_some_and(|state| state.checked)
    }

    pub(crate) fn is_indeterminate(&self, id: u64) -> bool {
        self.choices.states.get(&id).is_some_and(|state| state.indeterminate)
    }

    pub(crate) fn default_checked(&self, id: u64) -> bool {
        self.choices.states.get(&id).is_some_and(|state| state.default_checked)
    }

    /// A write of `checked`, `defaultChecked` or `indeterminate` to the element, whether or not the
    /// prop's value changed: it is the property assignment React DOM makes, and the one `input.checked =`
    /// makes. Called before the prop is stored.
    pub(crate) fn input_prop_written(&mut self, id: u64, key: &str, value: &Value) {
        // Removing `defaultChecked` is removing the `checked` attribute: a clean control is unchecked.
        let removed_default = key == "defaultChecked" && value.is_null();
        let Some(flag) = value.as_bool().or(removed_default.then_some(false)) else {
            return;
        };
        match key {
            "checked" => self.write_checked(id, flag),
            "defaultChecked" => {
                let Some(state) = self.choices.states.get_mut(&id) else {
                    return;
                };
                state.default_checked = flag;
                if !state.dirty && state.checked != flag {
                    state.checked = flag;
                    self.checkedness_changed(id);
                }
            }
            "indeterminate" => {
                let Some(state) = self.choices.states.get_mut(&id) else {
                    return;
                };
                if state.indeterminate != flag {
                    state.indeterminate = flag;
                    self.mark_render_changed(id);
                }
            }
            _ => {}
        }
    }

    /// The `type` or `name` of an input changed, so it may join a radio group that is already
    /// checked: a checked radio unchecks the others of its group.
    pub(crate) fn input_group_changed(&mut self, id: u64) {
        if self.is_checked(id) && self.radio_of(id) {
            self.uncheck_group_of(id);
        }
    }

    fn radio_of(&self, id: u64) -> bool {
        self.elements.get(&id).and_then(choice_of) == Some(Choice::Radio)
    }

    fn write_checked(&mut self, id: u64, checked: bool) {
        let Some(state) = self.choices.states.get_mut(&id) else {
            return;
        };
        state.dirty = true;
        if state.checked == checked {
            return;
        }
        state.checked = checked;
        self.checkedness_changed(id);
    }

    fn checkedness_changed(&mut self, id: u64) {
        if self.is_checked(id) && self.radio_of(id) {
            self.uncheck_group_of(id);
        }
        self.mark_render_changed(id);
    }

    fn uncheck_group_of(&mut self, id: u64) {
        for other in self.radio_group(id) {
            if let Some(state) = self.choices.states.get_mut(&other) {
                if state.checked {
                    state.checked = false;
                    self.mark_render_changed(other);
                }
            }
        }
    }

    /// The other radios of the group `id` is in, in id order. A radio with no `name` is alone.
    pub(crate) fn radio_group(&self, id: u64) -> Vec<u64> {
        let Some(element) = self.elements.get(&id) else {
            return Vec::new();
        };
        let Some(name) = element.custom_props().get("name").and_then(Value::as_str).filter(|name| !name.is_empty()) else {
            return Vec::new();
        };
        let form = crate::forms::enclosing_form(self, id);
        let top = crate::events::keyboard::path_to_root(self, id).last().copied();
        let mut group: Vec<u64> = self
            .choices
            .states
            .keys()
            .copied()
            .filter(|other| *other != id)
            .filter(|other| {
                let Some(candidate) = self.elements.get(other) else {
                    return false;
                };
                choice_of(candidate) == Some(Choice::Radio)
                    && candidate.custom_props().get("name").and_then(Value::as_str) == Some(name)
                    && crate::forms::enclosing_form(self, *other) == form
                    && (form.is_some() || crate::events::keyboard::path_to_root(self, *other).last().copied() == top)
            })
            .collect();
        group.sort_unstable();
        group
    }

    /// Whether a radio of the group `id` is in, itself included, is checked.
    pub(crate) fn radio_group_has_checked(&self, id: u64) -> bool {
        self.is_checked(id) || self.radio_group(id).into_iter().any(|other| self.is_checked(other))
    }

    /// Whether a radio of the group `id` is in, itself included, is `required`: then the whole
    /// group is, and none of its radios may be missing a check.
    pub(crate) fn radio_group_has_required(&self, id: u64) -> bool {
        let required = |id: u64| {
            self.elements
                .get(&id)
                .and_then(|element| element.custom_props().get("required"))
                .and_then(Value::as_bool)
                == Some(true)
        };
        required(id) || self.radio_group(id).into_iter().any(required)
    }

    /// Legacy-pre-activation of the checkbox or radio `id`, before the click's listeners run: a
    /// checkbox toggles and stops being indeterminate, a radio becomes checked and unchecks its
    /// group. Returns whether the activation began: it does not for another element, a disabled one
    /// or an inert one.
    pub(crate) fn pre_activate(&mut self, id: u64) -> bool {
        let Some(choice) = self.elements.get(&id).and_then(choice_of) else {
            return false;
        };
        if self.in_disabled_form_control(id) || self.is_inert(id) {
            return false;
        }
        let Some(state) = self.choices.states.get(&id) else {
            return false;
        };
        let mut undo = Undo { checked: state.checked, indeterminate: state.indeterminate, dirty: state.dirty, unchecked: None };
        match choice {
            Choice::Checkbox => {
                let next = !state.checked;
                self.write_checked(id, next);
                self.set_indeterminate(id, false);
            }
            Choice::Radio => {
                undo.unchecked = self.radio_group(id).into_iter().find(|other| self.is_checked(*other));
                self.write_checked(id, true);
            }
        }
        self.choices.pending.entry(id).or_default().push(undo);
        true
    }

    fn set_indeterminate(&mut self, id: u64, indeterminate: bool) {
        if let Some(state) = self.choices.states.get_mut(&id) {
            if state.indeterminate != indeterminate {
                state.indeterminate = indeterminate;
                self.mark_render_changed(id);
            }
        }
    }

    fn take_pending(&mut self, id: u64) -> Option<Undo> {
        let stack = self.choices.pending.get_mut(&id)?;
        let undo = stack.pop();
        if stack.is_empty() {
            self.choices.pending.remove(&id);
        }
        undo
    }

    /// Legacy-canceled-activation: a handler canceled the click, so the control is as it was.
    pub(crate) fn cancel_activation(&mut self, id: u64) {
        let Some(undo) = self.take_pending(id) else {
            return;
        };
        let Some(state) = self.choices.states.get_mut(&id) else {
            return;
        };
        state.checked = undo.checked;
        state.dirty = undo.dirty;
        state.indeterminate = undo.indeterminate;
        if let Some(other) = undo.unchecked {
            if let Some(state) = self.choices.states.get_mut(&other) {
                state.checked = true;
            }
            self.mark_render_changed(other);
        }
        self.mark_render_changed(id);
    }

    /// The click was not canceled: whether the control's checkedness differs from before it, which
    /// is when `input` and `change` fire. A radio that was checked already did not change.
    pub(crate) fn finish_activation(&mut self, id: u64) -> bool {
        self.take_pending(id).is_some_and(|undo| undo.checked != self.is_checked(id))
    }

    /// A script's assignment to `checked`, `defaultChecked` or `indeterminate`: it changes the state
    /// and nothing the framework committed. The props are what `restore_controlled` goes back to, so
    /// a write that landed there would make the control one the user can no longer change.
    pub(crate) fn script_wrote_flag(&mut self, id: u64, name: &str, flag: bool) -> Result<(), String> {
        let element = self.elements.get(&id).ok_or_else(|| format!("Unknown element id {id}"))?;
        if element.element_type != "input" {
            return Err(format!("Element {id} is a <{}>, not an <input>", element.element_type));
        }
        if !matches!(name, "checked" | "defaultChecked" | "indeterminate") {
            return Err(format!("{name} is not a state of an <input>"));
        }
        self.input_prop_written(id, name, &Value::Bool(flag));
        Ok(())
    }

    /// What React DOM's `restoreControlledState` does after the handlers of a change: a control
    /// given a `checked` prop shows that prop, whatever the user's click made it, so a handler that
    /// does not take the new value leaves the control as it was. Its radio group is restored too,
    /// since the click unchecked it. A range with a `value` prop goes back to it. A text control is
    /// not restored.
    pub(crate) fn restore_controlled(&mut self, id: u64) {
        if self.elements.get(&id).is_some_and(super::input_range::is_range) {
            self.restore_range(id);
            return;
        }
        let mut ids = vec![id];
        ids.extend(self.radio_group(id));
        for id in ids {
            let controlled = self.elements.get(&id).and_then(|element| element.custom_props().get("checked")?.as_bool());
            let Some(checked) = controlled else {
                continue;
            };
            if let Some(state) = self.choices.states.get_mut(&id) {
                if state.checked != checked {
                    state.checked = checked;
                    self.mark_render_changed(id);
                }
            }
        }
    }
}

/// `<input type="checkbox">` and `<input type="radio">`: a box with the default size of the
/// browser's and nothing painted in it, a tab stop that Space activates. The size, the margin and the
/// `inline-block` display are the user agent style of its `type` (`html::input_ua_style`).
pub(crate) struct ChoiceElement {
    choice: Choice,
    toggled: u64,
}

impl ChoiceElement {
    fn new(choice: Choice) -> Self {
        Self { choice, toggled: 0 }
    }
}

impl CustomElement for ChoiceElement {
    fn render(
        &mut self,
        mut ctx: CustomRenderContext,
        _window: &mut gpui::Window,
        _cx: &mut gpui::Context<crate::renderer::GpuixView>,
    ) -> gpui::AnyElement {
        // An inert control takes no focus, though the tree may still have a handle for it.
        if ctx.inert {
            ctx.focus_handle = None;
        }
        let role = match self.choice {
            Choice::Checkbox => gpui::Role::CheckBox,
            Choice::Radio => gpui::Role::RadioButton,
        };
        self.toggled = ctx.toggled.map_or(0, |toggled| toggled as u64 + 1);
        let mut surface = gpui::div().id(crate::events::ids::host_element_id(ctx.id));
        // An explicit `aria-checked` or `aria-pressed` wins over the control's own state.
        let explicit = ctx.props.contains_key("aria-checked") || ctx.props.contains_key("aria-pressed");
        if let (Some(toggled), false) = (ctx.toggled, explicit) {
            surface = surface.aria_toggled(toggled);
        }
        super::custom_surface_with_role(surface, &ctx, Some(role)).into_any_element()
    }

    fn set_prop(&mut self, _key: &str, _value: Value) {}

    fn supported_props(&self) -> &'static [&'static str] {
        &[]
    }

    fn supported_events(&self) -> &'static [&'static str] {
        INPUT_EVENTS
    }

    fn destroy(&mut self) {}

    /// The toggled state is in the tree, whose revision moves with it; the word says what the last
    /// build read of it.
    fn retain_state(&self) -> Option<u64> {
        Some(self.toggled)
    }
}

/// `<input type="hidden">`: no box. It is in the tree for `FormData` and `value`.
struct HiddenElement;

impl CustomElement for HiddenElement {
    fn render(
        &mut self,
        _ctx: CustomRenderContext,
        _window: &mut gpui::Window,
        _cx: &mut gpui::Context<crate::renderer::GpuixView>,
    ) -> gpui::AnyElement {
        gpui::Empty.into_any_element()
    }

    fn set_prop(&mut self, _key: &str, _value: Value) {}

    fn supported_props(&self) -> &'static [&'static str] {
        &[]
    }

    fn supported_events(&self) -> &'static [&'static str] {
        &[]
    }

    fn destroy(&mut self) {}

    fn retain_state(&self) -> Option<u64> {
        Some(0)
    }
}

pub(super) const INPUT_EVENTS: &[&str] = &["change", "input", "keydown", "keyup", "focus", "blur"];

/// The `<input>` element: which control it is builds from its `type`.
pub(crate) struct InputElement {
    /// Every prop the element was given, replayed into a control that a change of `type` builds.
    props: HashMap<String, Value>,
    inner: Box<dyn CustomElement>,
    kind: Kind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Choice(Choice),
    Hidden,
    Range,
}

impl Kind {
    fn of(input_type: InputType) -> Self {
        match input_type {
            InputType::Checkbox => Self::Choice(Choice::Checkbox),
            InputType::Radio => Self::Choice(Choice::Radio),
            InputType::Hidden => Self::Hidden,
            InputType::Range => Self::Range,
            _ => Self::Text,
        }
    }

    fn build(self) -> Box<dyn CustomElement> {
        match self {
            Self::Text => Box::new(super::input::TextEditorElement::new(false)),
            Self::Choice(choice) => Box::new(ChoiceElement::new(choice)),
            Self::Hidden => Box::new(HiddenElement),
            Self::Range => Box::new(super::input_range::RangeElement::new()),
        }
    }
}

impl InputElement {
    pub(crate) fn new() -> Self {
        Self { props: HashMap::new(), inner: Kind::Text.build(), kind: Kind::Text }
    }
}

impl CustomElement for InputElement {
    fn render(
        &mut self,
        ctx: CustomRenderContext,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<crate::renderer::GpuixView>,
    ) -> gpui::AnyElement {
        self.inner.render(ctx, window, cx)
    }

    fn set_prop(&mut self, key: &str, value: Value) {
        if value.is_null() {
            self.props.remove(key);
        } else {
            self.props.insert(key.to_string(), value.clone());
        }
        if key == "type" {
            let kind = Kind::of(input_type(&self.props));
            if kind != self.kind {
                self.inner.destroy();
                self.inner = kind.build();
                self.kind = kind;
                for (key, value) in &self.props {
                    self.inner.set_prop(key, value.clone());
                }
                return;
            }
        }
        self.inner.set_prop(key, value);
    }

    fn supported_props(&self) -> &'static [&'static str] {
        // `type` comes first: a control is built by it before the props that it takes.
        &[
            "type",
            "value",
            "defaultValue",
            "placeholder",
            "readOnly",
            "disabled",
            "maxLength",
            "min",
            "max",
            "step",
            "minRows",
            "maxRows",
            "theme",
        ]
    }

    fn supported_events(&self) -> &'static [&'static str] {
        self.inner.supported_events()
    }

    fn destroy(&mut self) {
        self.inner.destroy();
    }

    fn retain_state(&self) -> Option<u64> {
        self.inner.retain_state()
    }

    fn unretained_because(&self) -> &'static str {
        self.inner.unretained_because()
    }

    fn follows_clock(&self, window: &gpui::Window, cx: &gpui::App) -> bool {
        self.inner.follows_clock(window, cx)
    }

    fn clock_due(&self) -> bool {
        self.inner.clock_due()
    }

    fn draws_changes_at_once(&self) -> bool {
        self.inner.draws_changes_at_once()
    }

    fn text_selection(&mut self, cx: &mut gpui::App) -> Option<super::text_selection::TextSelection> {
        self.inner.text_selection(cx)
    }

    fn text_value(&mut self, cx: &mut gpui::App) -> Option<String> {
        self.inner.text_value(cx)
    }

    fn set_text_selection(&mut self, request: super::text_selection::SelectionRequest, cx: &mut gpui::App) -> bool {
        self.inner.set_text_selection(request, cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(batch: &str) -> RetainedTree {
        let mut tree = RetainedTree::new();
        crate::batch::test_json::apply(&mut tree, batch).expect("valid batch");
        tree
    }

    /// root(1) > form(2) > radios 3 and 4 named `g`, a checkbox 5; radio 6 named `g` outside the
    /// form, under root.
    const GROUPS: &str = r#"[["createElement",1,"div"],["setRoot",1],
        ["createElement",2,"form"],["appendChild",1,2],
        ["createElement",3,"input"],["appendChild",2,3],["setCustomProp",3,"type","radio"],["setCustomProp",3,"name","g"],
        ["createElement",4,"input"],["appendChild",2,4],["setCustomProp",4,"type","radio"],["setCustomProp",4,"name","g"],
        ["createElement",5,"input"],["appendChild",2,5],["setCustomProp",5,"type","checkbox"],["setCustomProp",5,"name","g"],
        ["createElement",6,"input"],["appendChild",1,6],["setCustomProp",6,"type","radio"],["setCustomProp",6,"name","g"]]"#;

    #[test]
    fn a_checkbox_toggles_in_pre_activation_and_a_canceled_click_puts_it_back() {
        let mut tree = tree(GROUPS);
        tree.input_prop_written(5, "indeterminate", &Value::Bool(true));
        assert!(tree.pre_activate(5));
        assert!(tree.is_checked(5));
        assert!(!tree.is_indeterminate(5), "a user toggle clears indeterminate");
        tree.cancel_activation(5);
        assert!(!tree.is_checked(5));
        assert!(tree.is_indeterminate(5));

        assert!(tree.pre_activate(5));
        assert!(tree.finish_activation(5), "an uncanceled click that changed it fires input and change");
        assert!(tree.is_checked(5));
    }

    #[test]
    fn a_radio_unchecks_its_group_in_its_form_and_not_a_radio_outside_it() {
        let mut tree = tree(GROUPS);
        assert!(tree.pre_activate(6));
        assert!(tree.pre_activate(3));
        assert!(tree.finish_activation(3));
        assert!(tree.pre_activate(4));
        assert!(tree.finish_activation(4));
        assert!(!tree.is_checked(3) && tree.is_checked(4));
        assert!(tree.is_checked(6), "another group: not in the form");
        assert!(tree.pre_activate(4));
        assert!(!tree.finish_activation(4), "a radio that was checked does not change");
    }

    #[test]
    fn a_canceled_radio_click_checks_the_previous_radio_again() {
        let mut tree = tree(GROUPS);
        tree.input_prop_written(3, "checked", &Value::Bool(true));
        assert!(tree.pre_activate(4));
        assert!(tree.is_checked(4) && !tree.is_checked(3));
        tree.cancel_activation(4);
        assert!(tree.is_checked(3) && !tree.is_checked(4));
    }

    #[test]
    fn radios_with_no_form_share_a_group_by_name_in_the_same_tree() {
        let mut tree = tree(
            r#"[["createElement",1,"div"],["setRoot",1],
                ["createElement",2,"input"],["appendChild",1,2],["setCustomProp",2,"type","radio"],["setCustomProp",2,"name","a"],
                ["createElement",3,"input"],["appendChild",1,3],["setCustomProp",3,"type","radio"],["setCustomProp",3,"name","a"],
                ["createElement",4,"input"],["appendChild",1,4],["setCustomProp",4,"type","radio"]]"#,
        );
        assert_eq!(tree.radio_group(2), vec![3]);
        assert!(tree.radio_group(4).is_empty(), "no name, no group");
        tree.input_prop_written(2, "checked", &Value::Bool(true));
        tree.input_prop_written(3, "checked", &Value::Bool(true));
        assert!(!tree.is_checked(2) && tree.is_checked(3));
    }

    #[test]
    fn a_radio_group_is_required_when_any_radio_in_it_is() {
        let mut tree = tree(GROUPS);
        assert!(!tree.radio_group_has_required(3));
        tree.set_custom_prop(4, "required".to_string(), Value::Bool(true));
        assert!(tree.radio_group_has_required(3), "a sibling's required makes the group required");
        assert!(tree.radio_group_has_required(4));
        assert!(!tree.radio_group_has_required(6), "another group: not in the form");
    }

    #[test]
    fn default_checked_sets_the_checkedness_only_while_it_is_not_dirty() {
        let mut tree = tree(GROUPS);
        tree.input_prop_written(5, "defaultChecked", &Value::Bool(true));
        assert!(tree.is_checked(5));
        tree.input_prop_written(5, "defaultChecked", &Value::Bool(false));
        assert!(!tree.is_checked(5));
        tree.input_prop_written(5, "checked", &Value::Bool(true));
        tree.input_prop_written(5, "defaultChecked", &Value::Bool(false));
        assert!(tree.is_checked(5), "a write to checked made it dirty");
    }

    #[test]
    fn removing_the_default_unchecks_a_clean_control_and_not_a_dirty_one() {
        let mut tree = tree(GROUPS);
        tree.input_prop_written(5, "defaultChecked", &Value::Bool(true));
        assert!(tree.is_checked(5));
        tree.input_prop_written(5, "defaultChecked", &Value::Null);
        assert!(!tree.is_checked(5));
        tree.input_prop_written(5, "defaultChecked", &Value::Bool(true));
        tree.input_prop_written(5, "checked", &Value::Bool(true));
        tree.input_prop_written(5, "defaultChecked", &Value::Null);
        assert!(tree.is_checked(5), "a write to checked made it dirty");
    }

    #[test]
    fn a_disabled_control_does_not_activate() {
        let mut tree = tree(GROUPS);
        tree.set_custom_prop(5, "disabled".to_string(), Value::Bool(true));
        assert!(!tree.pre_activate(5));
        assert!(!tree.is_checked(5));
    }

    #[test]
    fn a_controlled_control_goes_back_to_its_prop_after_a_change() {
        let mut tree = tree(GROUPS);
        tree.set_custom_prop(3, "checked".to_string(), Value::Bool(true));
        tree.set_custom_prop(4, "checked".to_string(), Value::Bool(false));
        assert!(tree.pre_activate(4));
        assert!(tree.finish_activation(4));
        tree.restore_controlled(4);
        assert!(tree.is_checked(3) && !tree.is_checked(4));
    }

    #[test]
    fn a_script_write_changes_the_state_and_no_prop_so_there_is_nothing_to_go_back_to() {
        let mut tree = tree(GROUPS);
        tree.script_wrote_flag(5, "checked", true).expect("an input");
        assert!(tree.is_checked(5));
        assert!(!tree.elements[&5].custom_props().contains_key("checked"));
        assert!(tree.pre_activate(5));
        assert!(tree.finish_activation(5));
        tree.restore_controlled(5);
        assert!(!tree.is_checked(5), "the user's toggle stays: no committed prop");
        tree.script_wrote_flag(5, "defaultChecked", false).expect("an input");
        tree.script_wrote_flag(5, "indeterminate", true).expect("an input");
        assert!(tree.is_indeterminate(5) && !tree.default_checked(5));
        assert!(!tree.elements[&5].custom_props().contains_key("indeterminate"));
    }

    #[test]
    fn a_restore_goes_back_to_the_committed_prop_and_not_to_a_script_write() {
        let mut tree = tree(GROUPS);
        tree.set_custom_prop(5, "checked".to_string(), Value::Bool(false));
        tree.script_wrote_flag(5, "checked", true).expect("an input");
        assert!(tree.is_checked(5));
        tree.restore_controlled(5);
        assert!(!tree.is_checked(5));
    }

    #[test]
    fn nothing_restores_a_control_on_its_own() {
        let mut tree = tree(GROUPS);
        tree.set_custom_prop(5, "checked".to_string(), Value::Bool(false));
        assert!(tree.pre_activate(5));
        assert!(tree.finish_activation(5));
        assert!(tree.is_checked(5), "the click is kept until the adapter asks for the restore");
        tree.restore_controlled(5);
        assert!(!tree.is_checked(5));
    }

    #[test]
    fn a_script_write_of_another_element_or_another_state_is_refused() {
        let mut tree = tree(GROUPS);
        assert!(tree.script_wrote_flag(1, "checked", true).is_err(), "a div");
        assert!(tree.script_wrote_flag(5, "value", true).is_err());
        assert!(tree.script_wrote_flag(99, "checked", true).is_err());
    }

    #[test]
    fn the_value_defaults_to_on_for_a_choice_and_to_empty_for_a_hidden_input() {
        let mut tree = tree(GROUPS);
        tree.create_element(7, "input".to_string());
        tree.set_custom_prop(7, "type".to_string(), Value::String("hidden".to_string()));
        assert_eq!(value_of(&tree.elements[&5]), "on");
        assert_eq!(value_of(&tree.elements[&7]), "");
        tree.set_custom_prop(5, "value".to_string(), serde_json::json!(3));
        assert_eq!(value_of(&tree.elements[&5]), "3");
        assert!(is_hidden(&tree.elements[&7]) && !tree.elements[&7].needs_focus());
    }

    #[test]
    fn the_toggled_state_is_mixed_only_for_an_indeterminate_checkbox() {
        let mut tree = tree(GROUPS);
        tree.input_prop_written(5, "indeterminate", &Value::Bool(true));
        tree.input_prop_written(3, "indeterminate", &Value::Bool(true));
        assert_eq!(toggled_of(&tree, &tree.elements[&5]), Some(Toggled::Mixed));
        assert_eq!(toggled_of(&tree, &tree.elements[&3]), Some(Toggled::False));
        tree.input_prop_written(3, "checked", &Value::Bool(true));
        assert_eq!(toggled_of(&tree, &tree.elements[&3]), Some(Toggled::True));
    }
}
