//! `<input type="range">`.
//!
//! The control is a focusable box of Chrome's default size (129 by 16, 2px margin) with the
//! `slider` role, the sanitized value and its limits, and nothing painted in it: Base UI and other
//! web sliders draw their own track and thumb and handle the pointer themselves (see
//! `docs/fork/deviations.md`). What it does implement is the control's value and its keys.
//!
//! The value follows HTML. `min`, `max` and `step` default to 0, 100 and 1 (`step="any"` does not
//! snap); a `max` below `min` is `min`; the value is clamped to the limits and snapped to the step
//! counted from `min`, and with none it is the midpoint. It is read through `sanitize`, never stored
//! sanitized, so a change of a limit sanitizes the value again.
//!
//! The raw value is the last one written to the `value` prop or property (`Ranges`), or the one a key
//! set, and failing both the `value` prop or `defaultValue`. A key (arrows, Page Up and Down, Home and
//! End, as Chrome handles them) runs after the keydown's listeners and only if none cancelled it; it
//! changes the value and fires `input` and then `change` when the value moved. A write from code fires
//! nothing. Going back to a `value` prop, as React DOM restores a controlled input, is `restore_range`,
//! which the React adapter asks for after its handlers ran.

use std::collections::HashMap;

use gpui::prelude::*;
use gpui::{App, Keystroke, Window};
use rustc_hash::FxHashMap;
use serde_json::Value;

use super::input_choice::{input_type, INPUT_EVENTS};
use super::input_rules::{decimals, number_from_json, step_from_json, InputType};
use super::{CustomElement, CustomRenderContext};
use crate::events::activation::Activation;
use crate::events::sync_dispatch;
use crate::retained_tree::{RetainedElement, RetainedTree};

pub(crate) fn is_range(element: &RetainedElement) -> bool {
    element.element_type == "input" && input_type(element.custom_props()) == InputType::Range
}

/// Whether a focused range takes the key (a gpui key name) for itself, so it does not scroll.
pub(crate) fn takes_key(element: &RetainedElement, key: &str) -> bool {
    is_range(element) && matches!(key, "up" | "down" | "left" | "right" | "pageup" | "pagedown" | "home" | "end")
}

/// The limits and step a range's props give.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rules {
    pub min: f64,
    pub max: f64,
    /// `None` for `step="any"`.
    pub step: Option<f64>,
}

impl Rules {
    pub(crate) fn of(props: &HashMap<String, Value>) -> Self {
        let min = props.get("min").and_then(number_from_json).unwrap_or(0.0);
        let max = props.get("max").and_then(number_from_json).unwrap_or(100.0).max(min);
        let step = match props.get("step") {
            Some(Value::String(text)) if text.trim().eq_ignore_ascii_case("any") => None,
            other => Some(step_from_json(other)),
        };
        Self { min, max, step }
    }

    /// `value` clamped to the limits and snapped to the nearest step from `min` that is not past `max`
    /// (a tie rounds up, as the HTML algorithm suggests).
    fn clamp_to_step(self, value: f64) -> f64 {
        let value = value.clamp(self.min, self.max);
        let Some(step) = self.step else {
            return value;
        };
        let steps = ((value - self.min) / step).round();
        // The epsilon keeps 0.3 / 0.1 from counting as two steps.
        let most = ((self.max - self.min) / step + 1e-9).floor();
        let snapped = self.min + steps.min(most) * step;
        let scale = 10f64.powi(decimals(step).max(decimals(self.min)) as i32);
        // Adding 0.0 turns a -0 into 0, which JS prints as "0".
        (snapped * scale).round() / scale + 0.0
    }

    /// The sanitized value of a raw one, where `None` is a value that is not a number.
    pub(crate) fn sanitize(self, raw: Option<f64>) -> f64 {
        self.clamp_to_step(raw.unwrap_or(self.min + (self.max - self.min) / 2.0))
    }

    /// The value after `key` (a gpui key name) from `current`, or `None` for a key a slider ignores.
    /// Chrome steps `step="any"` by a hundredth of the range, and a page by a tenth or one step.
    pub(crate) fn after_key(self, key: &str, current: f64) -> Option<f64> {
        let step = self.step.unwrap_or((self.max - self.min) / 100.0);
        let page = ((self.max - self.min) / 10.0).max(step);
        let target = match key {
            "up" | "right" => current + step,
            "down" | "left" => current - step,
            "pageup" => current + page,
            "pagedown" => current - page,
            "home" => self.min,
            "end" => self.max,
            _ => return None,
        };
        Some(self.clamp_to_step(target))
    }
}

/// A range's sanitized value and its limits, as the slider node and the JS properties read them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reading {
    pub value: f64,
    pub rules: Rules,
}

impl Reading {
    /// The `value` property: the number as JS prints it.
    pub(crate) fn text(&self) -> String {
        format!("{}", self.value)
    }
}

/// What the range `element` holds now, or `None` for another element.
pub(crate) fn reading_of(tree: &RetainedTree, element: &RetainedElement) -> Option<Reading> {
    if !is_range(element) {
        return None;
    }
    let props = element.custom_props();
    let rules = Rules::of(props);
    let raw = match tree.ranges.written.get(&element.id) {
        Some(raw) => *raw,
        None => props.get("value").or_else(|| props.get("defaultValue")).and_then(number_from_json),
    };
    Some(Reading { value: rules.sanitize(raw), rules })
}

/// The value of every range that was written to, and not the prop's: `Some(None)` is a write that
/// was not a number, which sanitizes to the default.
#[derive(Default)]
pub(crate) struct Ranges {
    written: FxHashMap<u64, Option<f64>>,
}

impl Ranges {
    pub(crate) fn destroyed(&mut self, id: u64) {
        self.written.remove(&id);
    }
}

impl RetainedTree {
    /// A write of the `value` prop or property of `id`, whether or not the prop's value changed: it is
    /// the property assignment React DOM makes, and the user may have moved the slider since. Called
    /// before the prop is stored.
    pub(crate) fn range_value_written(&mut self, id: u64, value: &Value) {
        if !self.elements.get(&id).is_some_and(is_range) {
            return;
        }
        let changed = if value.is_null() {
            self.ranges.written.remove(&id).is_some()
        } else {
            let raw = number_from_json(value);
            self.ranges.written.insert(id, raw) != Some(raw)
        };
        if changed {
            self.mark_render_changed(id);
        }
    }

    /// A script's assignment to the `value` of a range: the value changes and the `value` prop the
    /// framework committed, which `restore_range` goes back to, does not.
    pub(crate) fn script_wrote_range_value(&mut self, id: u64, text: &str) -> Result<(), String> {
        if !self.elements.get(&id).is_some_and(is_range) {
            return Err(format!("Element {id} is not a range input"));
        }
        self.range_value_written(id, &Value::String(text.to_string()));
        Ok(())
    }

    /// The `type` of `id` changed: a value written to a range is not one of the text field it became.
    pub(crate) fn range_type_changed(&mut self, id: u64) {
        if !self.elements.get(&id).is_some_and(is_range) {
            self.ranges.written.remove(&id);
        }
    }

    fn range_moved(&mut self, id: u64, value: f64) {
        self.ranges.written.insert(id, Some(value));
        self.mark_render_changed(id);
    }

    /// What React DOM's `restoreControlledState` does after the handlers of a change: a slider given a
    /// `value` prop shows that prop, whatever the user's key made it.
    pub(super) fn restore_range(&mut self, id: u64) {
        let controlled = self.elements.get(&id).and_then(|element| element.custom_props().get("value")).map(number_from_json);
        if let Some(raw) = controlled {
            if self.ranges.written.get(&id) != Some(&raw) {
                self.ranges.written.insert(id, raw);
                self.mark_render_changed(id);
            }
        }
    }
}

/// A `keydown` that no listener cancelled, on the focused element. A range that has focus takes
/// arrows, Page Up and Down, Home and End, unless a control, alt or cmd key is held.
pub(crate) fn key_down(activation: &Activation, keystroke: &Keystroke, prevented: bool, window: &mut Window, cx: &mut App) {
    let modifiers = keystroke.modifiers;
    if prevented || modifiers.control || modifiers.alt || modifiers.platform {
        return;
    }
    let Some(focused) = activation.routing.focused_element(window, cx) else {
        return;
    };
    let (target, path) = {
        let mut tree = activation.tree.lock().unwrap();
        let Some(element) = tree.elements.get(&focused) else {
            return;
        };
        if element.is_disabled() || tree.is_inert(focused) {
            return;
        }
        let Some(reading) = reading_of(&tree, element) else {
            return;
        };
        let Some(target) = reading.rules.after_key(&keystroke.key, reading.value).filter(|target| *target != reading.value) else {
            return;
        };
        tree.range_moved(focused, target);
        (target, crate::events::path::event_path(&tree, focused))
    };
    activation.invalidate(window, cx);
    for event_type in ["input", "change"] {
        sync_dispatch::emit_full(window, cx, &activation.callback, focused, event_type, |payload| {
            payload.target = Some(focused as f64);
            payload.path = Some(path.iter().map(|id| *id as f64).collect());
            payload.value = Some(format!("{target}"));
        });
    }
}

/// `<input type="range">`: a tab stop with the slider role, and nothing painted in it.
pub(crate) struct RangeElement {
    /// What the last build read of the value; the tree's revision moves with it.
    read: u64,
}

impl RangeElement {
    pub(crate) fn new() -> Self {
        Self { read: 0 }
    }
}

impl CustomElement for RangeElement {
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
        let mut surface = gpui::div().id(crate::events::ids::host_element_id(ctx.id));
        if let Some(range) = ctx.range {
            self.read = range.value.to_bits();
            // Before `apply_accessibility`, so an explicit `aria-valuenow` or `aria-valuemin` wins.
            surface = surface
                .aria_numeric_value(range.value)
                .aria_min_numeric_value(range.rules.min)
                .aria_max_numeric_value(range.rules.max);
            if let Some(step) = range.rules.step {
                surface = surface.aria_numeric_value_step(step);
            }
        }
        super::custom_surface_with_role(surface, &ctx, Some(gpui::Role::Slider)).into_any_element()
    }

    fn set_prop(&mut self, _key: &str, _value: Value) {}

    fn supported_props(&self) -> &'static [&'static str] {
        &[]
    }

    fn supported_events(&self) -> &'static [&'static str] {
        INPUT_EVENTS
    }

    fn destroy(&mut self) {}

    fn retain_state(&self) -> Option<u64> {
        Some(self.read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(props: Value) -> Rules {
        Rules::of(&serde_json::from_value(props).expect("props"))
    }

    fn tree(batch: &str) -> RetainedTree {
        let mut tree = RetainedTree::new();
        crate::batch::test_json::apply(&mut tree, batch).expect("valid batch");
        tree
    }

    const RANGE: &str = r#"[["createElement",1,"div"],["setRoot",1],
        ["createElement",2,"input"],["appendChild",1,2],["setCustomProp",2,"type","range"],
        ["createElement",3,"input"],["appendChild",1,3],["setCustomProp",3,"type","text"]]"#;

    fn value_of(tree: &RetainedTree, id: u64) -> f64 {
        reading_of(tree, &tree.elements[&id]).expect("a range").value
    }

    #[test]
    fn the_limits_default_to_zero_to_one_hundred_by_one_and_the_value_to_the_midpoint() {
        let default = rules(json!({}));
        assert_eq!((default.min, default.max, default.step), (0.0, 100.0, Some(1.0)));
        assert_eq!(default.sanitize(None), 50.0);
        assert_eq!(rules(json!({ "min": 10, "max": 20 })).sanitize(None), 15.0);
    }

    #[test]
    fn a_max_below_min_is_min_and_any_does_not_snap() {
        let rules_below = rules(json!({ "min": 10, "max": 5 }));
        assert_eq!(rules_below.max, 10.0);
        assert_eq!(rules_below.sanitize(Some(3.0)), 10.0);
        let any = rules(json!({ "step": "any" }));
        assert_eq!(any.step, None);
        assert_eq!(any.sanitize(Some(33.3333)), 33.3333);
        assert_eq!(rules(json!({ "step": 0 })).step, Some(1.0));
        assert_eq!(rules(json!({ "step": "-2" })).step, Some(1.0));
    }

    #[test]
    fn a_value_is_clamped_and_snapped_to_the_step_from_min() {
        let r = rules(json!({ "min": 1, "max": 10, "step": 3 }));
        assert_eq!(r.sanitize(Some(-5.0)), 1.0);
        assert_eq!(r.sanitize(Some(2.0)), 1.0);
        assert_eq!(r.sanitize(Some(3.0)), 4.0, "nearer to 4 than to 1");
        assert_eq!(r.sanitize(Some(2.5)), 4.0, "a tie goes up");
        assert_eq!(r.sanitize(Some(99.0)), 10.0);
        assert_eq!(rules(json!({ "min": 0, "max": 10, "step": 4 })).sanitize(Some(10.0)), 8.0, "not past max");
    }

    #[test]
    fn a_decimal_step_does_not_accumulate_float_noise() {
        let r = rules(json!({ "min": 0, "max": 1, "step": 0.1 }));
        assert_eq!(r.sanitize(Some(0.3)), 0.3);
        assert_eq!(r.sanitize(Some(0.7)), 0.7);
        assert_eq!(r.sanitize(Some(1.0)), 1.0);
        assert_eq!(Reading { value: r.sanitize(Some(0.3)), rules: r }.text(), "0.3");
    }

    #[test]
    fn each_key_moves_the_value_as_chrome_does() {
        let r = rules(json!({ "min": 0, "max": 100, "step": 5 }));
        assert_eq!(r.after_key("right", 50.0), Some(55.0));
        assert_eq!(r.after_key("up", 50.0), Some(55.0));
        assert_eq!(r.after_key("left", 50.0), Some(45.0));
        assert_eq!(r.after_key("down", 50.0), Some(45.0));
        assert_eq!(r.after_key("pageup", 50.0), Some(60.0), "a tenth of the range");
        assert_eq!(r.after_key("pagedown", 50.0), Some(40.0));
        assert_eq!(r.after_key("home", 50.0), Some(0.0));
        assert_eq!(r.after_key("end", 50.0), Some(100.0));
        assert_eq!(r.after_key("right", 100.0), Some(100.0));
        assert_eq!(r.after_key("a", 50.0), None);
        let big = rules(json!({ "min": 0, "max": 10, "step": 5 }));
        assert_eq!(big.after_key("pageup", 0.0), Some(5.0), "a page is at least one step");
        let any = rules(json!({ "min": 0, "max": 200, "step": "any" }));
        assert_eq!(any.after_key("right", 10.0), Some(12.0), "a hundredth of the range");
    }

    #[test]
    fn the_value_is_the_last_write_then_the_value_prop_then_default_value() {
        let mut tree = tree(RANGE);
        assert_eq!(value_of(&tree, 2), 50.0);
        tree.set_custom_prop(2, "defaultValue".to_string(), json!(20));
        assert_eq!(value_of(&tree, 2), 20.0);
        tree.set_custom_prop(2, "value".to_string(), json!("70"));
        assert_eq!(value_of(&tree, 2), 70.0);
        tree.set_custom_prop(2, "value".to_string(), json!(500));
        assert_eq!(value_of(&tree, 2), 100.0, "sanitized on read");
        tree.set_custom_prop(2, "max".to_string(), json!(80));
        assert_eq!(value_of(&tree, 2), 80.0, "a new limit sanitizes the value again");
        tree.set_custom_prop(2, "value".to_string(), json!("abc"));
        assert_eq!(value_of(&tree, 2), 40.0, "not a number: the midpoint");
    }

    #[test]
    fn a_user_move_is_kept_until_the_prop_is_written_again_and_a_controlled_range_goes_back() {
        let mut tree = tree(RANGE);
        tree.set_custom_prop(2, "value".to_string(), json!(30));
        tree.range_moved(2, 31.0);
        assert_eq!(value_of(&tree, 2), 31.0);
        tree.restore_range(2);
        assert_eq!(value_of(&tree, 2), 30.0, "the prop says 30");
        tree.set_custom_prop(2, "value".to_string(), json!(30));
        tree.range_moved(2, 32.0);
        tree.set_custom_prop(2, "value".to_string(), json!(30));
        assert_eq!(value_of(&tree, 2), 30.0, "a write of the same prop is still a write");

        let mut uncontrolled = self::tree(RANGE);
        uncontrolled.set_custom_prop(2, "defaultValue".to_string(), json!(30));
        uncontrolled.range_moved(2, 31.0);
        uncontrolled.restore_range(2);
        assert_eq!(value_of(&uncontrolled, 2), 31.0, "no value prop, nothing to go back to");
    }

    #[test]
    fn a_script_write_is_sanitized_and_leaves_the_props_alone() {
        let mut tree = tree(RANGE);
        tree.set_custom_prop(2, "defaultValue".to_string(), json!(10));
        tree.script_wrote_range_value(2, "11").expect("a range");
        assert_eq!(value_of(&tree, 2), 11.0);
        tree.script_wrote_range_value(2, "500").expect("a range");
        assert_eq!(value_of(&tree, 2), 100.0);
        assert!(!tree.elements[&2].custom_props().contains_key("value"));
        tree.range_moved(2, 12.0);
        tree.restore_controlled(2);
        assert_eq!(value_of(&tree, 2), 12.0, "no value prop, so nothing to go back to");
        assert!(tree.script_wrote_range_value(3, "1").is_err(), "a text input");
    }

    #[test]
    fn a_restore_goes_back_to_the_value_prop_and_not_to_a_script_write() {
        let mut tree = tree(RANGE);
        tree.set_custom_prop(2, "value".to_string(), json!(30));
        tree.script_wrote_range_value(2, "60").expect("a range");
        tree.restore_controlled(2);
        assert_eq!(value_of(&tree, 2), 30.0);
    }

    #[test]
    fn rewriting_the_same_value_is_not_a_change() {
        let mut tree = tree(RANGE);
        tree.set_custom_prop(2, "value".to_string(), json!(30));
        tree.take_dirty();
        tree.range_value_written(2, &json!(30));
        assert_eq!(tree.take_dirty(), crate::retained_tree::Dirty::Clean);
    }

    #[test]
    fn a_text_input_has_no_reading_and_a_type_change_drops_what_was_written() {
        let mut tree = tree(RANGE);
        assert!(reading_of(&tree, &tree.elements[&3]).is_none());
        tree.set_custom_prop(3, "value".to_string(), json!(7));
        assert!(!tree.ranges.written.contains_key(&3));
        tree.range_moved(2, 12.0);
        tree.set_custom_prop(2, "type".to_string(), json!("text"));
        assert!(tree.ranges.written.is_empty());
        tree.set_custom_prop(2, "type".to_string(), json!("range"));
        assert_eq!(value_of(&tree, 2), 50.0);
    }

    #[test]
    fn a_range_does_not_scroll_for_the_keys_it_takes() {
        let tree = tree(RANGE);
        assert!(takes_key(&tree.elements[&2], "right"));
        assert!(takes_key(&tree.elements[&2], "end"));
        assert!(!takes_key(&tree.elements[&2], "space"));
        assert!(!takes_key(&tree.elements[&3], "right"));
    }
}
