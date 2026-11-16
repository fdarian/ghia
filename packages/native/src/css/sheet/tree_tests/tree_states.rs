//! The tree-state pseudo-classes (`css::sheet::tree_states`): that each is read from what native
//! holds, and that a write to a prop or to a checkedness marks the elements that read it and no others.

use serde_json::{json, Value};

use super::{Doc, ROOT};

/// An element whose prop `key` is `value`.
fn with_prop(doc: &mut Doc, tag: &str, class: &str, props: &[(&str, Value)]) -> u64 {
    let id = doc.classed(tag, ROOT, class);
    for (key, value) in props {
        doc.tree.set_custom_prop(id, (*key).into(), value.clone());
    }
    id
}

fn red(doc: &Doc, id: u64) -> bool {
    doc.color(id) == Some("red")
}

fn faded(doc: &Doc, id: u64) -> bool {
    doc.style(id).and_then(|style| style.opacity) == Some(0.5)
}

fn input(doc: &mut Doc, class: &str, kind: &str) -> u64 {
    with_prop(doc, "input", class, &[("type", json!(kind))])
}

/// Presses the control the way a click that no handler cancels does. No batch follows it, so what
/// the click marked is matched by what the native path ends with, not by a `flush`.
fn click(doc: &mut Doc, id: u64) {
    assert!(doc.tree.pre_activate(id));
    doc.tree.take_dirty_restyled();
    doc.tree.finish_activation(id);
}

/// A click a handler canceled.
fn canceled_click(doc: &mut Doc, id: u64) {
    assert!(doc.tree.pre_activate(id));
    doc.tree.take_dirty_restyled();
    doc.tree.cancel_activation(id);
    doc.tree.take_dirty_restyled();
}

#[test]
fn toggling_disabled_on_one_of_a_thousand_buttons_matches_one_element_again() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "button:disabled { color: red }");
    let buttons = doc.run(1000, "button", ROOT, "b");
    doc.flush();
    assert!(buttons.iter().all(|button| !red(&doc, *button)));

    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(buttons[500], "disabled".into(), json!(true))), 1);
    assert!(red(&doc, buttons[500]) && !red(&doc, buttons[499]));
    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(buttons[500], "disabled".into(), Value::Null)), 1);
    assert!(!red(&doc, buttons[500]));
}

#[test]
fn disabled_and_enabled_are_the_controls_and_the_form_control_stand_ins() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ":disabled { color: red } :enabled { opacity: 0.5 }");
    let button = doc.classed("button", ROOT, "a");
    let stand_in = with_prop(&mut doc, "div", "b", &[("formControl", json!("enabled"))]);
    let plain = with_prop(&mut doc, "div", "c", &[("disabled", json!(true))]);
    let span = doc.classed("span", ROOT, "d");
    doc.flush();
    assert_eq!((red(&doc, button), faded(&doc, button)), (false, true));
    assert_eq!((red(&doc, stand_in), faded(&doc, stand_in)), (false, true));
    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(stand_in, "formControl".into(), json!("disabled"))), 1);
    assert_eq!((red(&doc, stand_in), faded(&doc, stand_in)), (true, false));
    assert_eq!((doc.color(plain), faded(&doc, plain)), (None, false), "a div that is not a stand-in is no control");
    assert_eq!((doc.color(span), faded(&doc, span)), (None, false));
    doc.tree.set_custom_prop(button, "disabled".into(), json!(true));
    doc.flush();
    assert_eq!((red(&doc, button), faded(&doc, button)), (true, false));
}

#[test]
fn checked_follows_a_click_a_prop_and_the_type() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "input:checked { color: red } input:indeterminate { background-color: blue }");
    let boxes: Vec<u64> = (0..1000).map(|_| input(&mut doc, "c", "checkbox")).collect();
    let text = input(&mut doc, "t", "text");
    doc.flush();

    assert_eq!(doc.rematched(|doc| click(doc, boxes[7])), 1, "the one clicked, nothing else");
    assert!(red(&doc, boxes[7]) && !red(&doc, boxes[8]));
    assert_eq!(doc.rematched(|doc| click(doc, boxes[7])), 1);
    assert!(!red(&doc, boxes[7]));

    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(boxes[3], "checked".into(), json!(true))), 1);
    assert!(red(&doc, boxes[3]));
    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(boxes[3], "indeterminate".into(), json!(true))), 1);
    assert_eq!(doc.background(boxes[3]), Some("blue"));
    assert!(doc.tree.is_checked(boxes[3]));

    doc.tree.set_custom_prop(text, "checked".into(), json!(true));
    doc.tree.set_custom_prop(text, "indeterminate".into(), json!(true));
    doc.flush();
    assert_eq!((doc.color(text), doc.background(text)), (None, None), "neither state is a text input's");
    doc.tree.set_custom_prop(boxes[3], "type".into(), json!("text"));
    doc.flush();
    assert_eq!((doc.color(boxes[3]), doc.background(boxes[3])), (None, None), "no longer a checkbox");
}

#[test]
fn a_click_on_a_checkbox_restyles_what_follows_it() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "input:checked + label { color: red }");
    let mut pairs = Vec::new();
    for _ in 0..100 {
        let checkbox = input(&mut doc, "c", "checkbox");
        let label = doc.classed("label", ROOT, "l");
        pairs.push((checkbox, label));
    }
    doc.flush();
    assert_eq!(doc.rematched(|doc| click(doc, pairs[40].0)), 1, "the label, the checkbox itself is no subject");
    assert!(red(&doc, pairs[40].1) && !red(&doc, pairs[41].1));
}

#[test]
fn checking_a_radio_matches_it_and_the_one_it_unchecked() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "input:checked { color: red }");
    let radios: Vec<u64> = (0..50).map(|_| with_prop(&mut doc, "input", "r", &[("type", json!("radio")), ("name", json!("g"))])).collect();
    let other = with_prop(&mut doc, "input", "r", &[("type", json!("radio")), ("name", json!("h"))]);
    doc.flush();
    assert_eq!(doc.rematched(|doc| click(doc, radios[3])), 1);
    assert_eq!(doc.rematched(|doc| click(doc, other)), 1);
    assert_eq!(doc.rematched(|doc| click(doc, radios[9])), 2, "the radio now checked and the one that was");
    assert!(red(&doc, radios[9]) && !red(&doc, radios[3]) && red(&doc, other));

    doc.tree.set_custom_prop(radios[20], "checked".into(), json!(true));
    doc.flush();
    assert!(red(&doc, radios[20]) && !red(&doc, radios[9]), "a prop checks it and unchecks its group too");
}

#[test]
fn a_canceled_click_leaves_the_selectors_as_they_were() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "input:checked { color: red } input:indeterminate { background-color: blue }");
    let checkbox = input(&mut doc, "c", "checkbox");
    let first = with_prop(&mut doc, "input", "r", &[("type", json!("radio")), ("name", json!("g"))]);
    let second = with_prop(&mut doc, "input", "r", &[("type", json!("radio")), ("name", json!("g"))]);
    doc.tree.set_custom_prop(checkbox, "indeterminate".into(), json!(true));
    doc.tree.set_custom_prop(first, "checked".into(), json!(true));
    doc.flush();

    assert!(doc.tree.pre_activate(checkbox));
    assert!(doc.tree.pre_activate(second));
    doc.tree.take_dirty_restyled();
    assert!(red(&doc, checkbox) && doc.background(checkbox).is_none() && red(&doc, second) && !red(&doc, first));
    doc.tree.cancel_activation(checkbox);
    doc.tree.cancel_activation(second);
    doc.tree.take_dirty_restyled();
    assert!(!red(&doc, checkbox) && doc.background(checkbox) == Some("blue"), "unchecked and indeterminate again");
    assert!(red(&doc, first) && !red(&doc, second));
}

#[test]
fn required_and_optional_are_the_fields_that_take_the_attribute() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ":required { color: red } :optional { background-color: blue }");
    let field = doc.classed("input", ROOT, "a");
    let select = doc.classed("select", ROOT, "b");
    let textarea = with_prop(&mut doc, "textarea", "c", &[("required", json!(true))]);
    let div = with_prop(&mut doc, "div", "d", &[("required", json!(true))]);
    doc.flush();
    assert_eq!((red(&doc, field), doc.background(field)), (false, Some("blue")));
    assert_eq!((red(&doc, select), doc.background(select)), (false, Some("blue")));
    assert_eq!((red(&doc, textarea), doc.background(textarea)), (true, None));
    assert_eq!((doc.color(div), doc.background(div)), (None, None));

    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(field, "required".into(), json!(true))), 1);
    assert_eq!((red(&doc, field), doc.background(field)), (true, None));
}

#[test]
fn read_write_is_a_text_field_that_is_neither_read_only_nor_disabled() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ":read-write { color: red } :read-only { background-color: blue }");
    let text = doc.classed("input", ROOT, "a");
    let email = input(&mut doc, "b", "EMAIL");
    let unknown = input(&mut doc, "c", "datetime-local");
    let checkbox = input(&mut doc, "d", "checkbox");
    let color = input(&mut doc, "e", "color");
    let textarea = doc.classed("textarea", ROOT, "f");
    let div = doc.classed("div", ROOT, "g");
    doc.flush();
    for id in [text, email, unknown, textarea] {
        assert_eq!((red(&doc, id), doc.background(id)), (true, None), "{id}");
    }
    for id in [checkbox, color, div] {
        assert_eq!((red(&doc, id), doc.background(id)), (false, Some("blue")), "{id}");
    }

    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(text, "readOnly".into(), json!(true))), 1);
    assert_eq!((red(&doc, text), doc.background(text)), (false, Some("blue")));
    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(textarea, "disabled".into(), json!(true))), 1);
    assert_eq!((red(&doc, textarea), doc.background(textarea)), (false, Some("blue")));
    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(checkbox, "type".into(), json!("text"))), 1);
    assert_eq!((red(&doc, checkbox), doc.background(checkbox)), (true, None));
}

#[test]
fn any_link_is_an_anchor_with_an_href() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ":any-link { color: red } a:link { background-color: blue }");
    let link = with_prop(&mut doc, "a", "a", &[("href", json!("/x"))]);
    let bare = doc.classed("a", ROOT, "b");
    let area = with_prop(&mut doc, "area", "c", &[("href", json!("/y"))]);
    let div = with_prop(&mut doc, "div", "d", &[("href", json!("/z"))]);
    doc.flush();
    assert!(red(&doc, link) && red(&doc, area) && !red(&doc, bare) && !red(&doc, div));
    assert_eq!(doc.background(link), Some("blue"));

    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(bare, "href".into(), json!("/w"))), 1);
    assert!(red(&doc, bare));
    doc.tree.set_custom_prop(link, "href".into(), Value::Null);
    doc.flush();
    assert!(!red(&doc, link));
}

#[test]
fn a_state_in_an_ancestor_or_sibling_position_reaches_what_it_names() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".w:disabled .x { color: red } .y:disabled + .z { background-color: blue } .y:disabled ~ .q { opacity: 0.5 }");
    let wrapper = with_prop(&mut doc, "div", "w", &[("formControl", json!("enabled"))]);
    let inner = doc.classed("span", wrapper, "x");
    let deep = doc.classed("span", inner, "x");
    let button = doc.classed("button", ROOT, "y");
    let next = doc.classed("span", ROOT, "z");
    let later = doc.classed("span", ROOT, "q");
    doc.flush();

    doc.tree.set_custom_prop(wrapper, "formControl".into(), json!("disabled"));
    doc.tree.set_custom_prop(button, "disabled".into(), json!(true));
    doc.flush();
    assert!(red(&doc, inner) && red(&doc, deep));
    assert_eq!(doc.background(next), Some("blue"));
    assert_eq!(doc.style(later).and_then(|style| style.opacity), Some(0.5));
}

#[test]
fn a_state_works_inside_not_is_and_where() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "button:not(:disabled) { color: red } :is(:checked, :required) { background-color: blue }");
    let on = doc.classed("button", ROOT, "a");
    let off = with_prop(&mut doc, "button", "a", &[("disabled", json!(true))]);
    let checkbox = input(&mut doc, "c", "checkbox");
    doc.flush();
    assert!(red(&doc, on) && !red(&doc, off) && doc.background(checkbox).is_none());
    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(on, "disabled".into(), json!(true))), 1);
    assert!(!red(&doc, on));
    assert_eq!(doc.rematched(|doc| click(doc, checkbox)), 1);
    assert_eq!(doc.background(checkbox), Some("blue"));
}

#[test]
fn elements_that_share_classes_but_not_a_state_are_not_shared() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a:disabled { color: red }");
    let first = doc.classed("button", ROOT, "a");
    let second = doc.classed("button", ROOT, "a");
    doc.tree.set_custom_prop(first, "disabled".into(), json!(true));
    doc.flush();
    assert!(red(&doc, first) && !red(&doc, second));
}

#[test]
fn a_sheet_that_reads_no_state_marks_nothing_when_a_prop_or_a_checkedness_changes() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a { color: red }");
    let checkbox = input(&mut doc, "a", "checkbox");
    let radio = with_prop(&mut doc, "input", "a", &[("type", json!("radio")), ("name", json!("g"))]);
    let other = with_prop(&mut doc, "input", "a", &[("type", json!("radio")), ("name", json!("g"))]);
    let anchor = doc.classed("a", ROOT, "a");
    doc.flush();
    let marked = doc.rematched(|doc| {
        for (id, key) in [(checkbox, "disabled"), (checkbox, "required"), (checkbox, "readOnly"), (anchor, "href"), (checkbox, "type")] {
            doc.tree.set_custom_prop(id, key.into(), json!(true));
        }
        doc.tree.set_custom_prop(checkbox, "indeterminate".into(), json!(true));
        click(doc, radio);
        click(doc, other);
        doc.tree.set_custom_prop(anchor, "formControl".into(), json!("disabled"));
    });
    assert_eq!(marked, 0);
}

#[test]
fn a_sheet_that_reads_one_state_marks_nothing_for_the_props_of_the_others() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "input:disabled { color: red }");
    let field = doc.classed("input", ROOT, "a");
    let checkbox = input(&mut doc, "b", "checkbox");
    doc.flush();
    let marked = doc.rematched(|doc| {
        doc.tree.set_custom_prop(field, "required".into(), json!(true));
        doc.tree.set_custom_prop(field, "href".into(), json!("/x"));
        click(doc, checkbox);
    });
    assert_eq!(marked, 0);
    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(field, "disabled".into(), json!(true))), 1);
}

#[test]
fn a_sheet_added_after_the_props_matches_the_state_they_already_made() {
    let mut doc = Doc::new();
    let checkbox = input(&mut doc, "a", "checkbox");
    let button = doc.classed("button", ROOT, "b");
    doc.tree.set_custom_prop(button, "disabled".into(), json!(true));
    click(&mut doc, checkbox);
    doc.style_element(ROOT, "input:checked, button:disabled { color: red }");
    doc.flush();
    assert!(red(&doc, checkbox) && red(&doc, button));
}

fn label_after(doc: &mut Doc, sheet: &str) -> (u64, u64) {
    doc.style_element(ROOT, sheet);
    let input = input(doc, "i", "checkbox");
    let label = doc.classed("label", ROOT, "l");
    doc.flush();
    assert!(!red(doc, label));
    (input, label)
}

#[test]
fn a_click_restyles_the_label_that_follows_the_checkbox_with_no_batch() {
    let mut doc = Doc::new();
    let (input, label) = label_after(&mut doc, "input:checked + label { color: red }");
    click(&mut doc, input);
    assert!(red(&doc, label));
    click(&mut doc, input);
    assert!(!red(&doc, label));
}

#[test]
fn a_script_write_restyles_the_label_that_follows_the_checkbox_with_no_batch() {
    let mut doc = Doc::new();
    let (input, label) = label_after(&mut doc, "input:checked + label { color: red } input:indeterminate + label { opacity: 0.5 }");
    doc.tree.script_wrote_flag(input, "checked", true).expect("an input");
    doc.tree.take_dirty_restyled();
    assert!(red(&doc, label));
    doc.tree.script_wrote_flag(input, "indeterminate", true).expect("an input");
    doc.tree.take_dirty_restyled();
    assert!(faded(&doc, label));
}

#[test]
fn restoring_a_controlled_checkbox_restyles_the_label_with_no_batch() {
    let mut doc = Doc::new();
    let (input, label) = label_after(&mut doc, "input:checked + label { color: red }");
    doc.tree.set_custom_prop(input, "checked".into(), json!(false));
    doc.flush();
    click(&mut doc, input);
    assert!(red(&doc, label));
    doc.tree.restore_controlled(input);
    doc.tree.take_dirty_restyled();
    assert!(!red(&doc, label), "the prop the framework committed is shown again");
}

#[test]
fn a_canceled_click_puts_the_label_back_with_no_batch() {
    let mut doc = Doc::new();
    let (input, label) = label_after(&mut doc, "input:checked + label { color: red }");
    canceled_click(&mut doc, input);
    assert!(!red(&doc, label));
}

#[test]
fn a_radio_unchecked_by_its_group_restyles_what_follows_it_with_no_batch() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "input:checked + label { color: red }");
    let first = with_prop(&mut doc, "input", "r", &[("type", json!("radio")), ("name", json!("g"))]);
    let first_label = doc.classed("label", ROOT, "l");
    let second = with_prop(&mut doc, "input", "r", &[("type", json!("radio")), ("name", json!("g"))]);
    let second_label = doc.classed("label", ROOT, "l");
    doc.flush();
    click(&mut doc, first);
    assert!(red(&doc, first_label) && !red(&doc, second_label));
    click(&mut doc, second);
    assert!(!red(&doc, first_label) && red(&doc, second_label));
}
